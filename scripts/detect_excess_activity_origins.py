#!/usr/bin/env python3

import argparse
import datetime as dt
import json
import math
import pathlib
import sqlite3
import statistics
from collections import Counter, defaultdict, deque
from zoneinfo import ZoneInfo

import numpy as np

from build_masters_flight_trails import (
    GRID_CELL_MILES,
    MAP_BOUNDS,
    ROOT_DIR,
    UTC,
    download_heatmap,
    grid_cell_bounds,
    grid_cell_for,
    iter_slots,
    local_window,
    tracked_aircraft_keys,
)
from build_masters_takeoff_landing_maps import (
    Observation,
    decode_altitude,
    decode_ground_speed,
    detect_events_for_aircraft,
    point_key,
)


DB_PATH = ROOT_DIR / "data" / "ews-main.sqlite"
OUT_JSON = ROOT_DIR / "excess_origin_detector_summary.json"
OUT_REPORT = ROOT_DIR / "excess_origin_detector_report.md"
PACIFIC = ZoneInfo("America/Los_Angeles")

MIN_DAY_SAMPLES = 44
RANK_LOOKBACK_DAYS = 370
MIN_BURST_RESIDUAL = 80
BASELINE_COUNT = 3
BASELINE_EXCLUDE_DAYS = 21
ENDPOINT_CLUSTER_RADIUS_MILES = 12
ENDPOINT_CLUSTER_MIN_POINTS = 3
MAX_ENDPOINT_CLUSTERS = 8
EARTH_RADIUS_MILES = 3958.7613


def slot_index_for_local(timestamp):
    return timestamp.hour * 2 + (1 if timestamp.minute >= 30 else 0)


def slot_start_for_sample_local(timestamp):
    minute = 30 if timestamp.minute >= 30 else 0
    return timestamp.replace(minute=minute, second=0, microsecond=0)


def local_date_at_slot(date_value, slot):
    return dt.datetime.combine(date_value, dt.time(hour=slot // 2, minute=30 if slot % 2 else 0), tzinfo=PACIFIC)


def load_metric_items():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    try:
        max_iso = connection.execute("SELECT MAX(sampled_at) FROM concurrent_metrics").fetchone()[0]
        max_utc = dt.datetime.fromisoformat(max_iso)
        start_utc = max_utc - dt.timedelta(days=RANK_LOOKBACK_DAYS)
        rows = connection.execute(
            """
            SELECT sampled_at, concurrent_count
            FROM concurrent_metrics
            WHERE sampled_at >= ?
              AND sampled_at <= ?
            ORDER BY sampled_at
            """,
            (start_utc.isoformat(), max_utc.isoformat()),
        ).fetchall()
    finally:
        connection.close()

    items = []
    for row in rows:
        utc_timestamp = dt.datetime.fromisoformat(row["sampled_at"])
        local_timestamp = utc_timestamp.astimezone(PACIFIC)
        slot = slot_index_for_local(local_timestamp)
        items.append(
            {
                "utc": utc_timestamp,
                "local": local_timestamp,
                "date": local_timestamp.date(),
                "slot": slot,
                "weekday": local_timestamp.weekday(),
                "count": int(row["concurrent_count"]),
            }
        )
    return items


def annotate_metric_baseline(items):
    by_weekday_slot = defaultdict(list)
    for item in items:
        by_weekday_slot[(item["weekday"], item["slot"])].append(item)

    for values in by_weekday_slot.values():
        values.sort(key=lambda item: item["date"])

    for item in items:
        candidates = [
            other["count"]
            for other in by_weekday_slot[(item["weekday"], item["slot"])]
            if other["date"] != item["date"] and 10 < abs((other["date"] - item["date"]).days) <= 182
        ]
        if len(candidates) < 8:
            candidates = [
                other["count"]
                for other in by_weekday_slot[(item["weekday"], item["slot"])]
                if other["date"] != item["date"]
            ]

        expected = statistics.median(candidates) if candidates else item["count"]
        deviations = [abs(value - expected) for value in candidates]
        mad = statistics.median(deviations) if deviations else 1
        sigma = max(1, 1.4826 * mad)
        item["expected"] = expected
        item["residual"] = item["count"] - expected
        item["z"] = item["residual"] / sigma


def group_items_by_date(items):
    by_date = defaultdict(list)
    for item in items:
        by_date[item["date"]].append(item)
    for date_value in list(by_date):
        by_date[date_value].sort(key=lambda item: item["slot"])
    return by_date


def find_best_burst_window(day_items):
    peak = max(day_items, key=lambda item: item["residual"])
    threshold = max(MIN_BURST_RESIDUAL, 0.30 * peak["residual"])
    groups = []
    current = []
    gap_count = 0

    for item in day_items:
        if item["residual"] >= threshold:
            current.append(item)
            gap_count = 0
            continue

        if current and gap_count < 1 and item["residual"] >= 0:
            current.append(item)
            gap_count += 1
            continue

        if current:
            while current and current[-1]["residual"] < threshold:
                current.pop()
            if current:
                groups.append(current)
        current = []
        gap_count = 0

    if current:
        while current and current[-1]["residual"] < threshold:
            current.pop()
        if current:
            groups.append(current)

    if not groups:
        return None

    best = max(groups, key=lambda group: sum(item["residual"] for item in group))
    start_sample = best[0]["local"]
    end_sample = best[-1]["local"]
    local_start = slot_start_for_sample_local(start_sample)
    local_end = slot_start_for_sample_local(end_sample) + dt.timedelta(minutes=30)
    return {
        "items": best,
        "local_start": local_start,
        "local_end": local_end,
        "start_slot": slot_index_for_local(local_start),
        "end_slot": slot_index_for_local(local_end - dt.timedelta(minutes=1)) + 1,
        "score": sum(item["residual"] for item in best),
        "positive_score": sum(max(0, item["residual"]) for item in best),
        "peak_residual": peak["residual"],
        "peak_count": peak["count"],
        "peak_expected": peak["expected"],
        "peak_z": peak["z"],
        "peak_local": peak["local"],
        "threshold": threshold,
    }


def rank_candidate_days(items, max_candidates):
    by_date = group_items_by_date(items)
    candidates = []
    for date_value, day_items in by_date.items():
        if len(day_items) < MIN_DAY_SAMPLES:
            continue
        burst = find_best_burst_window(day_items)
        if not burst:
            continue
        candidates.append(
            {
                "date": date_value,
                "weekday": day_items[0]["weekday"],
                "sample_count": len(day_items),
                "daily_positive_residual": sum(max(0, item["residual"]) for item in day_items),
                "burst": burst,
            }
        )

    candidates.sort(key=lambda item: (item["burst"]["score"], item["burst"]["peak_residual"]), reverse=True)
    return candidates[:max_candidates], candidates


def residual_sum_for_window(by_date, date_value, start_slot, end_slot):
    day = {item["slot"]: item for item in by_date.get(date_value, [])}
    values = [day.get(slot) for slot in range(start_slot, end_slot)]
    if any(value is None for value in values):
        return None
    return sum(item["residual"] for item in values), sum(abs(item["residual"]) for item in values)


def choose_baseline_dates(candidate, by_date, excluded_dates, baseline_count):
    start_slot = candidate["burst"]["start_slot"]
    end_slot = candidate["burst"]["end_slot"]
    target_date = candidate["date"]
    rows = []
    for date_value, day_items in by_date.items():
        if date_value == target_date or date_value in excluded_dates:
            continue
        if day_items[0]["weekday"] != candidate["weekday"]:
            continue
        if abs((date_value - target_date).days) <= BASELINE_EXCLUDE_DAYS:
            continue
        score = residual_sum_for_window(by_date, date_value, start_slot, end_slot)
        if score is None:
            continue
        residual_sum, abs_residual_sum = score
        rows.append(
            {
                "date": date_value,
                "residual_sum": residual_sum,
                "abs_residual_sum": abs_residual_sum,
                "distance_days": abs((date_value - target_date).days),
            }
        )

    rows.sort(key=lambda row: (abs(row["residual_sum"]), row["abs_residual_sum"], row["distance_days"]))
    return rows[:baseline_count]


def scan_window(local_start, local_end, tracked_keys):
    start_utc = local_start.astimezone(UTC)
    end_utc = local_end.astimezone(UTC)
    observations_by_aircraft = defaultdict(list)
    presence_aircraft = defaultdict(set)
    files = []
    downloaded = 0
    kept_points = 0

    for slot in iter_slots(start_utc, end_utc):
        path, used_cache = download_heatmap(slot)
        files.append(str(path.relative_to(ROOT_DIR)))
        if not used_cache:
            downloaded += 1
        kept_points += scan_heatmap_file(path, tracked_keys, observations_by_aircraft, presence_aircraft)

    events = []
    for aircraft_key, observations in observations_by_aircraft.items():
        events.extend(detect_events_for_aircraft(aircraft_key, observations))

    takeoffs = [event for event in events if event.event_type == "takeoff"]
    landings = [event for event in events if event.event_type == "landing"]
    return {
        "local_start": local_start.isoformat(),
        "local_end": local_end.isoformat(),
        "files": files,
        "downloaded_files": downloaded,
        "kept_points": kept_points,
        "observed_aircraft": len(observations_by_aircraft),
        "presence_counts": {cell: len(values) for cell, values in presence_aircraft.items()},
        "takeoff_counts": event_counts_by_cell(takeoffs),
        "landing_counts": event_counts_by_cell(landings),
        "takeoff_points": event_points(takeoffs),
        "landing_points": event_points(landings),
        "takeoff_events": len(takeoffs),
        "landing_events": len(landings),
    }


def scan_heatmap_file(path, tracked_keys, observations_by_aircraft, presence_aircraft):
    raw = path.read_bytes()
    points_u8 = np.frombuffer(raw, dtype=np.uint8)
    points_i = points_u8.view(np.int32)
    points_u = points_u8.view(np.uint32)

    marker = 0x0E7F7C9D
    marker_hits = np.nonzero(points_i == marker)[0]
    if not len(marker_hits):
        return 0

    lon_min, lat_min, lon_max, lat_max = MAP_BOUNDS
    lat_min_i = int(lat_min * 1_000_000)
    lat_max_i = int(lat_max * 1_000_000)
    lon_min_i = int(lon_min * 1_000_000)
    lon_max_i = int(lon_max * 1_000_000)

    index = int(marker_hits[0])
    point_count = len(points_i)
    kept = 0

    while index < point_count:
        if points_i[index] != marker:
            index += 1
            continue

        now = points_u[index + 2] / 1000 + points_u[index + 1] * 4294967.296
        ts = dt.datetime.fromtimestamp(float(now), tz=UTC).timestamp()
        index += 4

        while index < point_count and points_i[index] != marker:
            point0_u = int(points_u[index])
            point1 = int(points_i[index + 1])

            if point1 >= 1073741824:
                index += 4
                continue

            lat_i = point1
            lon_i = int(points_i[index + 2])
            if lat_i < lat_min_i or lat_i > lat_max_i or lon_i < lon_min_i or lon_i > lon_max_i:
                index += 4
                continue

            key = point_key(point0_u)
            if key not in tracked_keys:
                index += 4
                continue

            lat = lat_i / 1_000_000
            lon = lon_i / 1_000_000
            point3 = int(points_i[index + 3])
            alt_ft, ground = decode_altitude(point3)
            gs_kt = decode_ground_speed(point3)
            observations_by_aircraft[key].append(
                Observation(ts=ts, lon=lon, lat=lat, alt_ft=alt_ft, ground=ground, gs_kt=gs_kt)
            )
            if not ground:
                presence_aircraft[grid_cell_for(lon, lat)].add(key)
            kept += 1
            index += 4

    return kept


def event_counts_by_cell(events):
    counts = Counter()
    for event in events:
        counts[grid_cell_for(event.lon, event.lat)] += 1
    return dict(counts)


def event_points(events):
    return [
        {
            "lat": event.lat,
            "lon": event.lon,
            "aircraft_key": event.aircraft_key,
            "ts": event.ts,
            "confidence": event.confidence,
            "reason": event.reason,
        }
        for event in events
    ]


def median_baseline_counts(baseline_windows, key):
    cells = set()
    for window in baseline_windows:
        cells.update(window[key])

    medians = {}
    for cell in cells:
        medians[cell] = statistics.median([window[key].get(cell, 0) for window in baseline_windows])
    return medians


def delta_counts(current_counts, baseline_counts):
    cells = set(current_counts) | set(baseline_counts)
    return {cell: current_counts.get(cell, 0) - baseline_counts.get(cell, 0) for cell in cells}


def haversine_miles(lat1, lon1, lat2, lon2):
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lam = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lam / 2) ** 2
    return EARTH_RADIUS_MILES * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def project_endpoint(point, reference_lat):
    return (
        EARTH_RADIUS_MILES * math.radians(point["lon"]) * math.cos(math.radians(reference_lat)),
        EARTH_RADIUS_MILES * math.radians(point["lat"]),
    )


def endpoint_neighbors(index, points, coordinates, buckets, radius_miles):
    x, y = coordinates[index]
    bucket = (math.floor(x / radius_miles), math.floor(y / radius_miles))
    neighbors = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for candidate in buckets.get((bucket[0] + dx, bucket[1] + dy), []):
                if haversine_miles(
                    points[index]["lat"],
                    points[index]["lon"],
                    points[candidate]["lat"],
                    points[candidate]["lon"],
                ) <= radius_miles:
                    neighbors.append(candidate)
    return neighbors


def dbscan_endpoints(points, radius_miles=ENDPOINT_CLUSTER_RADIUS_MILES, min_points=ENDPOINT_CLUSTER_MIN_POINTS):
    if not points:
        return []

    reference_lat = statistics.median(point["lat"] for point in points)
    coordinates = [project_endpoint(point, reference_lat) for point in points]
    buckets = defaultdict(list)
    for index, (x, y) in enumerate(coordinates):
        buckets[(math.floor(x / radius_miles), math.floor(y / radius_miles))].append(index)

    labels = [None] * len(points)
    cluster_id = 0
    for index in range(len(points)):
        if labels[index] is not None:
            continue

        neighbors = endpoint_neighbors(index, points, coordinates, buckets, radius_miles)
        if len(neighbors) < min_points:
            labels[index] = -1
            continue

        labels[index] = cluster_id
        queue = deque(neighbors)
        while queue:
            candidate = queue.popleft()
            if labels[candidate] == -1:
                labels[candidate] = cluster_id
                continue
            if labels[candidate] is not None:
                continue

            labels[candidate] = cluster_id
            candidate_neighbors = endpoint_neighbors(candidate, points, coordinates, buckets, radius_miles)
            if len(candidate_neighbors) >= min_points:
                queue.extend(candidate_neighbors)

        cluster_id += 1

    return labels


def center_for_points(points):
    if not points:
        return None
    return {
        "lat": sum(point["lat"] for point in points) / len(points),
        "lon": sum(point["lon"] for point in points) / len(points),
    }


def serialize_endpoint_cluster(cluster):
    center = cluster["center"]
    return {
        "id": cluster["id"],
        "point_count": cluster["point_count"],
        "current_count": cluster["current_count"],
        "baseline_median_count": cluster["baseline_median_count"],
        "baseline_counts": cluster["baseline_counts"],
        "total_delta": cluster["total_delta"],
        "unique_aircraft_current": cluster["unique_aircraft_current"],
        "unique_aircraft_baseline_median": cluster["unique_aircraft_baseline_median"],
        "unique_aircraft_delta": cluster["unique_aircraft_delta"],
        "center": center,
        "radius_miles": cluster["radius_miles"],
        "query_radius_miles": ENDPOINT_CLUSTER_RADIUS_MILES,
        "reason_counts": cluster["reason_counts"],
    }


def summarize_endpoint_clusters(current_window, baseline_windows, point_key):
    windows = [current_window] + baseline_windows
    points = []
    for window_index, window in enumerate(windows):
        for point in window.get(point_key, []):
            points.append({**point, "window_index": window_index})

    labels = dbscan_endpoints(points)
    cluster_points = defaultdict(list)
    noise_counts = [0] * len(windows)
    for point, label in zip(points, labels):
        if label == -1:
            noise_counts[point["window_index"]] += 1
        else:
            cluster_points[label].append(point)

    clusters = []
    for cluster_id, items in cluster_points.items():
        current_items = [point for point in items if point["window_index"] == 0]
        center_source = current_items if current_items else items
        center = center_for_points(center_source)
        radius_miles = 0
        for point in items:
            radius_miles = max(radius_miles, haversine_miles(center["lat"], center["lon"], point["lat"], point["lon"]))

        baseline_counts = [
            sum(1 for point in items if point["window_index"] == window_index)
            for window_index in range(1, len(windows))
        ]
        baseline_unique_counts = [
            len({point["aircraft_key"] for point in items if point["window_index"] == window_index})
            for window_index in range(1, len(windows))
        ]
        current_count = len(current_items)
        current_unique = len({point["aircraft_key"] for point in current_items})
        baseline_median = statistics.median(baseline_counts) if baseline_counts else 0
        baseline_unique_median = statistics.median(baseline_unique_counts) if baseline_unique_counts else 0
        reason_counts = Counter(point["reason"] for point in current_items)

        clusters.append(
            {
                "id": int(cluster_id),
                "point_count": len(items),
                "current_count": current_count,
                "baseline_median_count": baseline_median,
                "baseline_counts": baseline_counts,
                "total_delta": current_count - baseline_median,
                "unique_aircraft_current": current_unique,
                "unique_aircraft_baseline_median": baseline_unique_median,
                "unique_aircraft_delta": current_unique - baseline_unique_median,
                "center": center,
                "radius_miles": radius_miles,
                "reason_counts": dict(reason_counts.most_common(5)),
            }
        )

    positive_clusters = [cluster for cluster in clusters if cluster["total_delta"] > 0]
    negative_clusters = [cluster for cluster in clusters if cluster["total_delta"] < 0]
    positive_clusters.sort(key=lambda item: (item["total_delta"], item["current_count"]), reverse=True)
    negative_clusters.sort(key=lambda item: (item["total_delta"], item["current_count"]))

    total_current = len(current_window.get(point_key, []))
    baseline_totals = [len(window.get(point_key, [])) for window in baseline_windows]
    baseline_total_median = statistics.median(baseline_totals) if baseline_totals else 0
    return {
        "method": "endpoint-dbscan",
        "cluster_radius_miles": ENDPOINT_CLUSTER_RADIUS_MILES,
        "minimum_cluster_points": ENDPOINT_CLUSTER_MIN_POINTS,
        "current_total": total_current,
        "baseline_total_median": baseline_total_median,
        "net_total": total_current - baseline_total_median,
        "positive_total": sum(cluster["total_delta"] for cluster in positive_clusters),
        "negative_total": sum(cluster["total_delta"] for cluster in negative_clusters),
        "positive_clusters": len(positive_clusters),
        "negative_clusters": len(negative_clusters),
        "cluster_count": len(clusters),
        "noise_current_count": noise_counts[0] if noise_counts else 0,
        "noise_baseline_median_count": statistics.median(noise_counts[1:]) if len(noise_counts) > 1 else 0,
        "clusters": [
            serialize_endpoint_cluster(cluster)
            for cluster in positive_clusters[:MAX_ENDPOINT_CLUSTERS]
        ],
        "negative_clusters_detail": [
            serialize_endpoint_cluster(cluster)
            for cluster in negative_clusters[:MAX_ENDPOINT_CLUSTERS]
        ],
    }


def component_neighbors(cell):
    row, col = cell
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr == 0 and dc == 0:
                continue
            yield row + dr, col + dc


def cell_center(cell):
    lon0, lat0, lon1, lat1 = grid_cell_bounds(*cell)
    return {
        "lat": (lat0 + lat1) / 2,
        "lon": (lon0 + lon1) / 2,
        "bounds": [lon0, lat0, lon1, lat1],
    }


def weighted_center(cells, deltas):
    total = sum(max(0, deltas[cell]) for cell in cells)
    if total <= 0:
        centers = [cell_center(cell) for cell in cells]
        return {
            "lat": sum(center["lat"] for center in centers) / len(centers),
            "lon": sum(center["lon"] for center in centers) / len(centers),
        }

    lat = 0
    lon = 0
    for cell in cells:
        weight = max(0, deltas[cell])
        center = cell_center(cell)
        lat += center["lat"] * weight
        lon += center["lon"] * weight
    return {"lat": lat / total, "lon": lon / total}


def positive_components(deltas):
    positives = {cell for cell, value in deltas.items() if value > 0}
    components = []

    while positives:
        start = positives.pop()
        queue = deque([start])
        cells = {start}
        while queue:
            cell = queue.popleft()
            for neighbor in component_neighbors(cell):
                if neighbor in positives:
                    positives.remove(neighbor)
                    cells.add(neighbor)
                    queue.append(neighbor)

        total_delta = sum(deltas[cell] for cell in cells)
        top_cell = max(cells, key=lambda cell: deltas[cell])
        components.append(
            {
                "cells": sorted(cells),
                "cell_count": len(cells),
                "total_delta": total_delta,
                "top_cell": top_cell,
                "top_cell_delta": deltas[top_cell],
                "center": weighted_center(cells, deltas),
            }
        )

    components.sort(key=lambda item: (item["total_delta"], item["top_cell_delta"]), reverse=True)
    return components


def summarize_deltas(deltas):
    positive_total = sum(value for value in deltas.values() if value > 0)
    negative_total = sum(value for value in deltas.values() if value < 0)
    positive_cells = sum(1 for value in deltas.values() if value > 0)
    negative_cells = sum(1 for value in deltas.values() if value < 0)
    neutral_cells = sum(1 for value in deltas.values() if value == 0)
    top_cell = max(deltas, key=lambda cell: deltas[cell]) if deltas else None
    return {
        "positive_total": positive_total,
        "negative_total": negative_total,
        "net_total": sum(deltas.values()),
        "positive_cells": positive_cells,
        "negative_cells": negative_cells,
        "neutral_cells": neutral_cells,
        "top_cell": serialize_cell(top_cell, deltas[top_cell]) if top_cell else None,
        "compact_neighborhoods": [
            serialize_neighborhood(neighborhood)
            for neighborhood in compact_neighborhoods(deltas)[:6]
        ],
        "components": [serialize_component(component) for component in positive_components(deltas)[:6]],
    }


def serialize_cell(cell, delta):
    center = cell_center(cell)
    return {
        "row": cell[0],
        "col": cell[1],
        "delta": delta,
        "center": {"lat": center["lat"], "lon": center["lon"]},
        "bounds": center["bounds"],
    }


def serialize_component(component):
    return {
        "cell_count": component["cell_count"],
        "total_delta": component["total_delta"],
        "top_cell_delta": component["top_cell_delta"],
        "center": component["center"],
        "top_cell": serialize_cell(component["top_cell"], component["top_cell_delta"]),
    }


def compact_neighborhoods(deltas, radius=1):
    positives = {cell for cell, value in deltas.items() if value > 0}
    neighborhoods = []
    for cell in positives:
        row, col = cell
        cells = {
            candidate
            for candidate in positives
            if abs(candidate[0] - row) <= radius and abs(candidate[1] - col) <= radius
        }
        total_delta = sum(deltas[candidate] for candidate in cells)
        top_cell = max(cells, key=lambda candidate: deltas[candidate])
        neighborhoods.append(
            {
                "cells": cells,
                "cell_count": len(cells),
                "total_delta": total_delta,
                "top_cell": top_cell,
                "top_cell_delta": deltas[top_cell],
                "center": weighted_center(cells, deltas),
            }
        )

    neighborhoods.sort(key=lambda item: (item["total_delta"], item["top_cell_delta"]), reverse=True)

    deduped = []
    seen = set()
    for neighborhood in neighborhoods:
        key = tuple(sorted(neighborhood["cells"]))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(neighborhood)
    return deduped


def serialize_neighborhood(neighborhood):
    return {
        "cell_count": neighborhood["cell_count"],
        "total_delta": neighborhood["total_delta"],
        "top_cell_delta": neighborhood["top_cell_delta"],
        "center": neighborhood["center"],
        "top_cell": serialize_cell(neighborhood["top_cell"], neighborhood["top_cell_delta"]),
    }


def top_cell_share(summary):
    if not summary["top_cell"] or summary["positive_total"] <= 0:
        return 0
    return summary["top_cell"]["delta"] / summary["positive_total"]


def compact_share(summary):
    if not summary["compact_neighborhoods"] or summary["positive_total"] <= 0:
        return 0
    return summary["compact_neighborhoods"][0]["total_delta"] / summary["positive_total"]


def endpoint_share(summary):
    if not summary or not summary["clusters"] or summary["positive_total"] <= 0:
        return 0
    return summary["clusters"][0]["total_delta"] / summary["positive_total"]


def classify_pattern(
    presence_summary,
    takeoff_summary,
    landing_summary,
    takeoff_endpoint_summary=None,
    landing_endpoint_summary=None,
):
    takeoff_compact_share = compact_share(takeoff_summary)
    landing_compact_share = compact_share(landing_summary)
    presence_compact_share = compact_share(presence_summary)
    takeoff_endpoint_share = endpoint_share(takeoff_endpoint_summary)
    landing_endpoint_share = endpoint_share(landing_endpoint_summary)
    takeoff_cell_share = top_cell_share(takeoff_summary)
    landing_cell_share = top_cell_share(landing_summary)
    presence_cell_share = top_cell_share(presence_summary)

    anchor_score = max(
        takeoff_endpoint_share,
        landing_endpoint_share,
        takeoff_compact_share,
        landing_compact_share,
        presence_compact_share,
    )
    if takeoff_endpoint_share >= 0.26 or takeoff_compact_share >= 0.30 or takeoff_cell_share >= 0.18:
        label = "specific departure anchor"
        theory = "A continuous endpoint cluster generated a large share of excess departures; this is the data shape expected from a specific airport or airport group emptying out."
    elif landing_endpoint_share >= 0.26 or landing_compact_share >= 0.30 or landing_cell_share >= 0.18:
        label = "specific arrival anchor"
        theory = "A continuous endpoint cluster absorbed a large share of excess arrivals; this is the data shape expected from a specific airport or airport group drawing traffic in."
    elif takeoff_endpoint_share >= 0.14 or (takeoff_compact_share >= 0.16 and takeoff_compact_share >= landing_compact_share):
        label = "regional departure concentration"
        theory = "The excess has a strongest departure region, but it is too spatially broad to call a single origin from the endpoint clusters alone."
    elif landing_endpoint_share >= 0.14 or landing_compact_share >= 0.16:
        label = "regional arrival concentration"
        theory = "The excess has a strongest arrival region, but it is too spatially broad to call a single destination from the endpoint clusters alone."
    else:
        label = "diffuse national redistribution"
        theory = "The excess is spread across many endpoint clusters; this looks more like broad return-to-work or holiday travel than one origin."

    return {
        "label": label,
        "theory": theory,
        "anchor_score": anchor_score,
        "takeoff_endpoint_share": takeoff_endpoint_share,
        "landing_endpoint_share": landing_endpoint_share,
        "presence_compact_share": presence_compact_share,
        "takeoff_compact_share": takeoff_compact_share,
        "landing_compact_share": landing_compact_share,
        "presence_cell_share": presence_cell_share,
        "takeoff_cell_share": takeoff_cell_share,
        "landing_cell_share": landing_cell_share,
    }


def analyze_candidate(candidate, baseline_rows, tracked_keys):
    local_start = candidate["burst"]["local_start"]
    local_end = candidate["burst"]["local_end"]
    print(
        f"  scanning current {candidate['date']} {local_start.strftime('%H:%M')}-{local_end.strftime('%H:%M')}...",
        flush=True,
    )
    current_window = scan_window(local_start, local_end, tracked_keys)

    baseline_windows = []
    for row in baseline_rows:
        baseline_start = local_start.replace(
            year=row["date"].year,
            month=row["date"].month,
            day=row["date"].day,
        )
        baseline_end = baseline_start + (local_end - local_start)
        print(
            f"  scanning baseline {row['date']} {baseline_start.strftime('%H:%M')}-{baseline_end.strftime('%H:%M')}...",
            flush=True,
        )
        baseline_windows.append(scan_window(baseline_start, baseline_end, tracked_keys))

    baseline_presence = median_baseline_counts(baseline_windows, "presence_counts")
    baseline_takeoffs = median_baseline_counts(baseline_windows, "takeoff_counts")
    baseline_landings = median_baseline_counts(baseline_windows, "landing_counts")

    presence_deltas = delta_counts(current_window["presence_counts"], baseline_presence)
    takeoff_deltas = delta_counts(current_window["takeoff_counts"], baseline_takeoffs)
    landing_deltas = delta_counts(current_window["landing_counts"], baseline_landings)

    presence_summary = summarize_deltas(presence_deltas)
    takeoff_summary = summarize_deltas(takeoff_deltas)
    landing_summary = summarize_deltas(landing_deltas)
    takeoff_endpoint_summary = summarize_endpoint_clusters(current_window, baseline_windows, "takeoff_points")
    landing_endpoint_summary = summarize_endpoint_clusters(current_window, baseline_windows, "landing_points")
    classification = classify_pattern(
        presence_summary,
        takeoff_summary,
        landing_summary,
        takeoff_endpoint_summary,
        landing_endpoint_summary,
    )

    return {
        "current": current_window,
        "baselines": baseline_windows,
        "baseline_dates": [
            {
                "date": row["date"].isoformat(),
                "residual_sum": row["residual_sum"],
                "abs_residual_sum": row["abs_residual_sum"],
            }
            for row in baseline_rows
        ],
        "presence_delta_summary": presence_summary,
        "takeoff_delta_summary": takeoff_summary,
        "landing_delta_summary": landing_summary,
        "takeoff_endpoint_summary": takeoff_endpoint_summary,
        "landing_endpoint_summary": landing_endpoint_summary,
        "classification": classification,
    }


def candidate_to_payload(rank, candidate, analysis):
    burst = candidate["burst"]
    return {
        "rank": rank,
        "date": candidate["date"].isoformat(),
        "local_start": burst["local_start"].isoformat(),
        "local_end": burst["local_end"].isoformat(),
        "weekday": burst["local_start"].strftime("%A"),
        "duration_hours": (burst["local_end"] - burst["local_start"]).total_seconds() / 3600,
        "burst_score": burst["score"],
        "daily_positive_residual": candidate["daily_positive_residual"],
        "peak": {
            "local": burst["peak_local"].isoformat(),
            "residual": burst["peak_residual"],
            "count": burst["peak_count"],
            "expected": burst["peak_expected"],
            "z": burst["peak_z"],
        },
        "baseline_dates": analysis["baseline_dates"],
        "current_observed_aircraft": analysis["current"]["observed_aircraft"],
        "current_takeoff_events": analysis["current"]["takeoff_events"],
        "current_landing_events": analysis["current"]["landing_events"],
        "downloaded_files": analysis["current"]["downloaded_files"]
        + sum(window["downloaded_files"] for window in analysis["baselines"]),
        "presence_delta_summary": analysis["presence_delta_summary"],
        "takeoff_delta_summary": analysis["takeoff_delta_summary"],
        "landing_delta_summary": analysis["landing_delta_summary"],
        "takeoff_endpoint_summary": analysis["takeoff_endpoint_summary"],
        "landing_endpoint_summary": analysis["landing_endpoint_summary"],
        "classification": analysis["classification"],
    }


def format_coord(center):
    return f"{center['lat']:.2f}, {center['lon']:.2f}"


def top_component(summary):
    return summary["components"][0] if summary["components"] else None


def top_neighborhood(summary):
    return summary["compact_neighborhoods"][0] if summary["compact_neighborhoods"] else None


def write_report(payload):
    lines = []
    lines.append("# Excess Activity Origin Detector")
    lines.append("")
    lines.append("This report uses only tracked-aircraft heatmap observations and the historical concurrent-count baseline in the local database. It does not use event calendars, airport lists, or web lookups.")
    lines.append("")
    lines.append("## Method")
    lines.append("")
    lines.append("- Rank local days by same-weekday, same-half-hour residual bursts over the last year.")
    lines.append(f"- For each top burst, compare the burst window to {payload['baseline_count']} quiet same-weekday baseline windows from the surrounding year.")
    lines.append(f"- Bin unique presence, inferred takeoffs, and inferred landings into roughly {GRID_CELL_MILES:.0f}-mile cells.")
    lines.append(f"- Cluster takeoff and landing endpoints directly with a {ENDPOINT_CLUSTER_RADIUS_MILES:.0f}-mile radius, so airports near cell edges are not split by the grid.")
    lines.append("- Identify positive endpoint clusters and fallback cell components, then classify each burst by concentration: single-origin, single-destination, regional cluster, or diffuse redistribution.")
    lines.append("")
    lines.append("## Top 10")
    lines.append("")
    lines.append("| Rank | Date | Window PDT | Peak Excess | Pattern | Strongest Compact Cluster | Theory |")
    lines.append("|---:|---|---|---:|---|---|---|")
    for item in payload["candidates"]:
        takeoff_clusters = item.get("takeoff_endpoint_summary", {}).get("clusters", [])
        landing_clusters = item.get("landing_endpoint_summary", {}).get("clusters", [])
        takeoff_cluster = takeoff_clusters[0] if takeoff_clusters else None
        landing_cluster = landing_clusters[0] if landing_clusters else None
        presence_cluster = top_neighborhood(item["presence_delta_summary"])
        top = takeoff_cluster or landing_cluster or presence_cluster
        location = format_coord(top["center"]) if top else "n/a"
        burst_start = dt.datetime.fromisoformat(item["local_start"]).strftime("%H:%M")
        burst_end = dt.datetime.fromisoformat(item["local_end"]).strftime("%H:%M")
        lines.append(
            f"| {item['rank']} | {item['date']} | {burst_start}-{burst_end} | "
            f"{item['peak']['residual']:.0f} | {item['classification']['label']} | "
            f"{location} | {item['classification']['theory']} |"
        )

    lines.append("")
    lines.append("## Case Notes")
    lines.append("")
    for item in payload["candidates"]:
        lines.append(f"### {item['rank']}. {item['date']} ({item['weekday']})")
        lines.append("")
        burst_start = dt.datetime.fromisoformat(item["local_start"]).strftime("%H:%M")
        burst_end = dt.datetime.fromisoformat(item["local_end"]).strftime("%H:%M")
        lines.append(
            f"Window: {burst_start}-{burst_end} PDT, {item['duration_hours']:.1f} hours. "
            f"Peak excess: {item['peak']['residual']:.0f} aircraft at "
            f"{dt.datetime.fromisoformat(item['peak']['local']).strftime('%H:%M')}."
        )
        lines.append(
            f"Observed aircraft in current window: {item['current_observed_aircraft']}; "
            f"inferred takeoffs: {item['current_takeoff_events']}; inferred landings: {item['current_landing_events']}."
        )
        lines.append(
            "Baseline dates: "
            + ", ".join(row["date"] for row in item["baseline_dates"])
            + "."
        )
        lines.append(
            f"Classification: **{item['classification']['label']}** "
            f"(compact anchor score {item['classification']['anchor_score']:.2f}; "
            f"takeoff endpoint {item['classification']['takeoff_endpoint_share']:.2f}, "
            f"landing endpoint {item['classification']['landing_endpoint_share']:.2f})."
        )

        for label, key in (
            ("Takeoff endpoint", "takeoff_endpoint_summary"),
            ("Landing endpoint", "landing_endpoint_summary"),
        ):
            clusters = item.get(key, {}).get("clusters", [])
            if not clusters:
                lines.append(f"- {label}: no positive airport endpoint cluster.")
                continue
            cluster = clusters[0]
            share = cluster["total_delta"] / max(1, item[key]["positive_total"])
            lines.append(
                f"- {label} cluster: {cluster['total_delta']:+.0f} events near "
                f"{format_coord(cluster['center'])}; share {share:.2f}; "
                f"current {cluster['current_count']} vs baseline median {cluster['baseline_median_count']:.1f}; "
                f"component spread {cluster['radius_miles']:.1f} mi."
            )

        for label, key in (
            ("Presence", "presence_delta_summary"),
            ("Takeoff", "takeoff_delta_summary"),
            ("Landing", "landing_delta_summary"),
        ):
            neighborhood = top_neighborhood(item[key])
            component = top_component(item[key])
            if neighborhood:
                share = neighborhood["total_delta"] / max(1, item[key]["positive_total"])
                lines.append(
                    f"- {label} compact cluster: {neighborhood['total_delta']:+.0f} across "
                    f"{neighborhood['cell_count']} cells, center {format_coord(neighborhood['center'])}; "
                    f"share {share:.2f}; top cell {neighborhood['top_cell_delta']:+.0f} at "
                    f"{format_coord(neighborhood['top_cell']['center'])}."
                )
            if not component:
                if not neighborhood:
                    lines.append(f"- {label}: no positive component.")
                continue
            lines.append(
                f"- {label} broad positive area: {component['total_delta']:+.0f} across "
                f"{component['cell_count']} cells, center {format_coord(component['center'])}; "
                f"top cell {component['top_cell_delta']:+.0f} at "
                f"{format_coord(component['top_cell']['center'])}."
            )

        lines.append(f"Theory: {item['classification']['theory']}")
        lines.append("")

    OUT_REPORT.write_text("\n".join(lines), "utf8")


def parse_args():
    parser = argparse.ArgumentParser(description="Detect spatial origins of excess tracked-aircraft activity.")
    parser.add_argument("--max-candidates", type=int, default=10)
    parser.add_argument("--baseline-count", type=int, default=BASELINE_COUNT)
    return parser.parse_args()


def main():
    args = parse_args()
    print("Loading metric history...", flush=True)
    items = load_metric_items()
    annotate_metric_baseline(items)
    by_date = group_items_by_date(items)
    top_candidates, all_candidates = rank_candidate_days(items, args.max_candidates)
    excluded_dates = {candidate["date"] for candidate in all_candidates[: max(30, args.max_candidates * 3)]}
    tracked_keys = tracked_aircraft_keys()

    payload = {
        "generated_at": dt.datetime.now(UTC).isoformat(),
        "database": str(DB_PATH.relative_to(ROOT_DIR)),
        "max_candidates": args.max_candidates,
        "baseline_count": args.baseline_count,
        "cell_size_miles": GRID_CELL_MILES,
        "endpoint_cluster_radius_miles": ENDPOINT_CLUSTER_RADIUS_MILES,
        "endpoint_cluster_min_points": ENDPOINT_CLUSTER_MIN_POINTS,
        "map_bounds": MAP_BOUNDS,
        "ranking": {
            "lookback_days": RANK_LOOKBACK_DAYS,
            "minimum_day_samples": MIN_DAY_SAMPLES,
            "minimum_burst_residual": MIN_BURST_RESIDUAL,
        },
        "candidates": [],
    }

    for rank, candidate in enumerate(top_candidates, start=1):
        burst = candidate["burst"]
        print(
            f"Analyzing #{rank}: {candidate['date']} "
            f"{burst['local_start'].strftime('%H:%M')}-{burst['local_end'].strftime('%H:%M')} "
            f"score {burst['score']:.0f}",
            flush=True,
        )
        baseline_rows = choose_baseline_dates(candidate, by_date, excluded_dates, args.baseline_count)
        if len(baseline_rows) < args.baseline_count:
            print(f"  warning: only found {len(baseline_rows)} baseline windows", flush=True)
        analysis = analyze_candidate(candidate, baseline_rows, tracked_keys)
        payload["candidates"].append(candidate_to_payload(rank, candidate, analysis))
        OUT_JSON.write_text(json.dumps(payload, indent=2), "utf8")
        write_report(payload)

    OUT_JSON.write_text(json.dumps(payload, indent=2), "utf8")
    write_report(payload)
    print(f"Wrote {OUT_JSON.relative_to(ROOT_DIR)}", flush=True)
    print(f"Wrote {OUT_REPORT.relative_to(ROOT_DIR)}", flush=True)


if __name__ == "__main__":
    main()
