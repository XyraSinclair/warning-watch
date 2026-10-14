#!/usr/bin/env python3

import datetime as dt
import json
import math
import pathlib
from collections import Counter, defaultdict
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw

from build_masters_flight_trails import (
    AUGUSTA,
    GRID_CELL_MILES,
    MAP_BOUNDS,
    PACIFIC,
    PANEL_SIZE,
    ROOT_DIR,
    UTC,
    WINDOWS,
    build_basemap,
    download_heatmap,
    grid_cell_bounds,
    grid_cell_for,
    iter_slots,
    load_font,
    local_window,
    project,
    tracked_aircraft_keys,
)


TAKEOFF_IMAGE = ROOT_DIR / "masters_takeoff_irregularity.png"
LANDING_IMAGE = ROOT_DIR / "masters_landing_irregularity.png"
EVENT_SUMMARY = ROOT_DIR / "masters_takeoff_landing_summary.json"

MAX_SEGMENT_GAP_SECONDS = 45 * 60
CONFIRM_WINDOW_SECONDS = 30 * 60
LOW_ALTITUDE_FT = 12_000
GROUND_SPEED_KT = 45
AIRBORNE_SPEED_KT = 60
CLIMB_DESCENT_FT = 1_000
EVENT_COOLDOWN_SECONDS = 8 * 60
MIN_GROUNDISH_RUN_SECONDS = 30


@dataclass(frozen=True)
class Observation:
    ts: float
    lon: float
    lat: float
    alt_ft: int | None
    ground: bool
    gs_kt: float | None


@dataclass(frozen=True)
class Event:
    event_type: str
    ts: float
    lon: float
    lat: float
    aircraft_key: int
    confidence: str
    reason: str


def point_key(point0_u):
    return (point0_u & 0x00FFFFFF) | (point0_u & 0x01000000)


def decode_altitude(point3):
    altitude = point3 & 0xFFFF
    if altitude & 0x8000:
        altitude |= -0x10000
    if altitude == -123:
        return None, True
    return altitude * 25, False


def decode_ground_speed(point3):
    value = point3 >> 16
    if value == -1:
        return None
    return value / 10


def haversine_nm(lat1, lon1, lat2, lon2):
    radius_nm = 3440.065
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lam = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lam / 2) ** 2
    return radius_nm * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def is_groundish(observation):
    if observation.ground:
        return True
    if observation.gs_kt is None:
        return False
    if observation.gs_kt > GROUND_SPEED_KT:
        return False
    return observation.alt_ft is None or observation.alt_ft <= LOW_ALTITUDE_FT


def is_airborne(observation):
    if observation.alt_ft is None or is_groundish(observation):
        return False
    return observation.gs_kt is None or observation.gs_kt >= AIRBORNE_SPEED_KT


def is_low_airborne(observation):
    if not is_airborne(observation):
        return False
    return observation.alt_ft <= LOW_ALTITUDE_FT or (
        observation.gs_kt is not None and observation.gs_kt <= 250
    )


def scan_observations(path, tracked_keys, observations_by_aircraft):
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

            point3 = int(points_i[index + 3])
            alt_ft, ground = decode_altitude(point3)
            gs_kt = decode_ground_speed(point3)
            observations_by_aircraft[key].append(
                Observation(
                    ts=ts,
                    lon=lon_i / 1_000_000,
                    lat=lat_i / 1_000_000,
                    alt_ft=alt_ft,
                    ground=ground,
                    gs_kt=gs_kt,
                )
            )
            kept += 1
            index += 4

    return kept


def dedupe_observations(observations):
    deduped = []
    last = None
    for observation in sorted(observations, key=lambda item: item.ts):
        comparable = (
            round(observation.ts),
            round(observation.lon, 5),
            round(observation.lat, 5),
            observation.alt_ft,
            observation.ground,
        )
        if comparable == last:
            continue
        deduped.append(observation)
        last = comparable
    return deduped


def split_segments(observations):
    segments = []
    current = []
    previous = None
    for observation in observations:
        if previous is not None and observation.ts - previous.ts > MAX_SEGMENT_GAP_SECONDS:
            if current:
                segments.append(current)
            current = []
        current.append(observation)
        previous = observation
    if current:
        segments.append(current)
    return segments


def make_runs(segment):
    runs = []
    current_phase = None
    start = 0
    for index, observation in enumerate(segment):
        if is_groundish(observation):
            phase = "ground"
        elif is_airborne(observation):
            phase = "air"
        else:
            phase = "unknown"

        if current_phase is None:
            current_phase = phase
            start = index
            continue

        if phase != current_phase:
            runs.append({"phase": current_phase, "start": start, "end": index - 1})
            current_phase = phase
            start = index

    if current_phase is not None:
        runs.append({"phase": current_phase, "start": start, "end": len(segment) - 1})

    merged = []
    for run in runs:
        if run["phase"] == "unknown":
            continue
        if merged and merged[-1]["phase"] == run["phase"]:
            merged[-1]["end"] = run["end"]
        else:
            merged.append(run)
    return merged


def run_duration(segment, run):
    return segment[run["end"]].ts - segment[run["start"]].ts


def run_has_ground_flag(segment, run):
    return any(item.ground for item in segment[run["start"] : run["end"] + 1])


def durable_ground_run(segment, run):
    return run_has_ground_flag(segment, run) or run_duration(segment, run) >= MIN_GROUNDISH_RUN_SECONDS


def segment_starts_after_inflight_dropout(previous_segment, current_segment):
    if previous_segment is None:
        return False
    previous_last_air_index = next(
        (index for index in range(len(previous_segment) - 1, -1, -1) if is_airborne(previous_segment[index])),
        None,
    )
    if previous_last_air_index is None:
        return False
    previous_last_air = previous_segment[previous_last_air_index]
    if is_low_airborne(previous_last_air):
        return False
    current_first_air_index = next((index for index, item in enumerate(current_segment) if is_airborne(item)), None)
    if current_first_air_index is None:
        return False
    return is_low_airborne(current_segment[current_first_air_index])


def segment_ends_before_inflight_dropout(current_segment, next_segment):
    if next_segment is None:
        return False
    current_last_air_index = next(
        (index for index in range(len(current_segment) - 1, -1, -1) if is_airborne(current_segment[index])),
        None,
    )
    if current_last_air_index is None:
        return False
    current_last_air = current_segment[current_last_air_index]
    if not is_low_airborne(current_last_air):
        return False
    next_first_air_index = next((index for index, item in enumerate(next_segment) if is_airborne(item)), None)
    if next_first_air_index is None:
        return False
    return not is_low_airborne(next_segment[next_first_air_index])


def observations_in_window(segment, start_ts, end_ts):
    return [item for item in segment if start_ts <= item.ts <= end_ts]


def altitude_values(observations):
    return [item.alt_ft for item in observations if item.alt_ft is not None]


def max_distance_from(origin, observations):
    if not observations:
        return 0
    return max(haversine_nm(origin.lat, origin.lon, item.lat, item.lon) for item in observations)


def confirm_takeoff(segment, origin_index, air_index):
    origin = segment[origin_index]
    future = observations_in_window(segment, segment[air_index].ts, origin.ts + CONFIRM_WINDOW_SECONDS)
    future_air = [item for item in future if is_airborne(item)]
    if len(future_air) < 3:
        return False, "insufficient-airborne-confirmation"

    altitudes = altitude_values(future_air)
    if not altitudes:
        return False, "missing-altitudes"

    origin_alt = origin.alt_ft if origin.alt_ft is not None else min(altitudes)
    climb = max(altitudes) - origin_alt
    distance_nm = max_distance_from(origin, future_air)
    max_speed = max((item.gs_kt or 0) for item in future_air)

    if climb >= CLIMB_DESCENT_FT and distance_nm >= 1.5:
        return True, "ground-to-climb"
    if climb >= 500 and distance_nm >= 8 and max_speed >= 120:
        return True, "low-departure-acceleration"
    return False, "weak-climb"


def confirm_landing(segment, air_index, touchdown_index):
    touchdown = segment[touchdown_index]
    past = observations_in_window(segment, touchdown.ts - CONFIRM_WINDOW_SECONDS, touchdown.ts)
    past_air = [item for item in past if is_airborne(item)]
    if len(past_air) < 3:
        return False, "insufficient-airborne-history"

    altitudes = altitude_values(past_air)
    if not altitudes:
        return False, "missing-altitudes"

    if touchdown.ground:
        touchdown_alt = min(altitudes[-8:] or altitudes)
    else:
        touchdown_alt = touchdown.alt_ft if touchdown.alt_ft is not None else min(altitudes)
    descent = max(altitudes) - touchdown_alt
    distance_nm = max_distance_from(touchdown, past_air)

    if touchdown.ground and distance_nm >= 1.0:
        return True, "air-to-ground"
    if descent >= CLIMB_DESCENT_FT and distance_nm >= 1.5:
        return True, "descent-to-groundish"
    return False, "weak-descent"


def confirm_low_start_takeoff(segment):
    first_air_index = next((index for index, item in enumerate(segment) if is_airborne(item)), None)
    if first_air_index is None:
        return None

    first = segment[first_air_index]
    if not is_low_airborne(first):
        return None

    confirmed, reason = confirm_takeoff(segment, first_air_index, first_air_index)
    if confirmed:
        return Event("takeoff", first.ts, first.lon, first.lat, 0, "inferred", f"segment-start-{reason}")
    return None


def confirm_low_end_landing(segment):
    last_air_index = next(
        (index for index in range(len(segment) - 1, -1, -1) if is_airborne(segment[index])),
        None,
    )
    if last_air_index is None:
        return None

    last = segment[last_air_index]
    if not is_low_airborne(last):
        return None

    past = observations_in_window(segment, last.ts - CONFIRM_WINDOW_SECONDS, last.ts)
    past_air = [item for item in past if is_airborne(item)]
    if len(past_air) < 3:
        return None
    altitudes = altitude_values(past_air)
    if not altitudes:
        return None
    descent = max(altitudes) - (last.alt_ft or min(altitudes))
    distance_nm = max_distance_from(last, past_air)
    if descent >= CLIMB_DESCENT_FT and distance_nm >= 1.5:
        return Event("landing", last.ts, last.lon, last.lat, 0, "inferred", "segment-end-low-descent")
    return None


def append_event(events, aircraft_key, event):
    event = Event(
        event_type=event.event_type,
        ts=event.ts,
        lon=event.lon,
        lat=event.lat,
        aircraft_key=aircraft_key,
        confidence=event.confidence,
        reason=event.reason,
    )
    for existing in reversed(events):
        if existing.event_type != event.event_type:
            continue
        if event.ts - existing.ts <= EVENT_COOLDOWN_SECONDS:
            return
        break
    events.append(event)


def detect_events_for_aircraft(aircraft_key, observations):
    observations = dedupe_observations(observations)
    events = []
    segments = split_segments(observations)

    for segment_index, segment in enumerate(segments):
        if len(segment) < 3:
            continue

        previous_segment = segments[segment_index - 1] if segment_index > 0 else None
        next_segment = segments[segment_index + 1] if segment_index + 1 < len(segments) else None
        runs = make_runs(segment)
        if not runs:
            continue

        if runs[0]["phase"] == "air" and not segment_starts_after_inflight_dropout(previous_segment, segment):
            event = confirm_low_start_takeoff(segment)
            if event:
                append_event(events, aircraft_key, event)

        for previous, current in zip(runs, runs[1:]):
            if previous["phase"] == "ground" and current["phase"] == "air":
                if not durable_ground_run(segment, previous):
                    continue
                origin_index = previous["end"]
                air_index = current["start"]
                confirmed, reason = confirm_takeoff(segment, origin_index, air_index)
                if confirmed:
                    origin = segment[origin_index]
                    append_event(
                        events,
                        aircraft_key,
                        Event("takeoff", origin.ts, origin.lon, origin.lat, 0, "observed", reason),
                    )
            elif previous["phase"] == "air" and current["phase"] == "ground":
                if not durable_ground_run(segment, current):
                    continue
                air_index = previous["end"]
                touchdown_index = current["start"]
                confirmed, reason = confirm_landing(segment, air_index, touchdown_index)
                if confirmed:
                    touchdown = segment[touchdown_index]
                    append_event(
                        events,
                        aircraft_key,
                        Event("landing", touchdown.ts, touchdown.lon, touchdown.lat, 0, "observed", reason),
                    )

        if runs[-1]["phase"] == "air" and not segment_ends_before_inflight_dropout(segment, next_segment):
            event = confirm_low_end_landing(segment)
            if event:
                append_event(events, aircraft_key, event)

    return events


def build_window_events(spec, tracked_keys):
    local_start, local_end = local_window(spec.date)
    start_utc = local_start.astimezone(UTC)
    end_utc = local_end.astimezone(UTC)

    observations_by_aircraft = defaultdict(list)
    files = []
    downloaded = 0
    kept_points = 0
    for slot in iter_slots(start_utc, end_utc):
        path, used_cache = download_heatmap(slot)
        files.append(str(path.relative_to(ROOT_DIR)))
        if not used_cache:
            downloaded += 1
        kept_points += scan_observations(path, tracked_keys, observations_by_aircraft)

    events = []
    for aircraft_key, observations in observations_by_aircraft.items():
        events.extend(detect_events_for_aircraft(aircraft_key, observations))

    takeoffs = [event for event in events if event.event_type == "takeoff"]
    landings = [event for event in events if event.event_type == "landing"]
    return {
        "key": spec.key,
        "title": spec.title,
        "date": spec.date,
        "local_start": local_start.isoformat(),
        "local_end": local_end.isoformat(),
        "utc_start": start_utc.isoformat(),
        "utc_end": end_utc.isoformat(),
        "files": files,
        "downloaded_files": downloaded,
        "kept_points": kept_points,
        "observed_aircraft": len(observations_by_aircraft),
        "takeoffs": takeoffs,
        "landings": landings,
        "takeoff_bins": bin_events(takeoffs),
        "landing_bins": bin_events(landings),
    }


def bin_events(events):
    counts = Counter()
    aircraft = defaultdict(set)
    reasons = Counter()
    for event in events:
        cell = grid_cell_for(event.lon, event.lat)
        counts[cell] += 1
        aircraft[cell].add(event.aircraft_key)
        reasons[event.reason] += 1
    return {
        "counts": counts,
        "unique_aircraft": {cell: len(values) for cell, values in aircraft.items()},
        "reasons": dict(reasons),
    }


def delta_bins(current, baseline, event_type):
    current_counts = current[f"{event_type}_bins"]["counts"]
    baseline_counts = baseline[f"{event_type}_bins"]["counts"]
    cells = set(current_counts) | set(baseline_counts)
    return {cell: current_counts.get(cell, 0) - baseline_counts.get(cell, 0) for cell in cells}


def delta_stats(current, baseline, event_type):
    deltas = delta_bins(current, baseline, event_type)
    positives = [value for value in deltas.values() if value > 0]
    negatives = [value for value in deltas.values() if value < 0]
    return {
        "cells": len(deltas),
        "positive_cells": len(positives),
        "negative_cells": len(negatives),
        "neutral_cells": len([value for value in deltas.values() if value == 0]),
        "max_positive": max(positives) if positives else 0,
        "max_negative": min(negatives) if negatives else 0,
        "net_delta": sum(deltas.values()),
    }


def draw_delta_grid(panel, deltas):
    if not deltas:
        return panel

    nonzero = sorted(abs(value) for value in deltas.values() if value)
    scale = nonzero[int(0.92 * (len(nonzero) - 1))] if nonzero else 1
    scale = max(scale, 1)

    overlay = Image.new("RGBA", panel.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay, "RGBA")
    for (row, col), delta in deltas.items():
        lon0, lat0, lon1, lat1 = grid_cell_bounds(row, col)
        corners = [
            project(lon0, lat0, MAP_BOUNDS, panel.size),
            project(lon1, lat0, MAP_BOUNDS, panel.size),
            project(lon1, lat1, MAP_BOUNDS, panel.size),
            project(lon0, lat1, MAP_BOUNDS, panel.size),
        ]
        if delta > 0:
            intensity = min(abs(delta) / scale, 1.0)
            fill = (204, 31, 38, int(52 + 132 * intensity))
            outline = (145, 24, 28, 160)
        elif delta < 0:
            intensity = min(abs(delta) / scale, 1.0)
            fill = (29, 91, 181, int(48 + 124 * intensity))
            outline = (23, 69, 139, 150)
        else:
            fill = (122, 122, 122, 42)
            outline = (94, 94, 94, 95)
        draw.polygon(corners, fill=fill)
        draw.line(corners + [corners[0]], fill=outline, width=1)

    return Image.alpha_composite(panel, overlay)


def draw_augusta(draw, panel_size):
    aug_x, aug_y = project(AUGUSTA["lon"], AUGUSTA["lat"], MAP_BOUNDS, panel_size)
    label_font = load_font(13)
    draw.ellipse((aug_x - 6, aug_y - 6, aug_x + 6, aug_y + 6), fill=(30, 30, 30, 230), outline=(255, 255, 255, 240), width=2)
    draw.text((aug_x + 9, aug_y - 18), "Augusta", fill=(35, 35, 35, 230), font=label_font, stroke_width=2, stroke_fill=(255, 255, 255, 210))


def draw_panel(base, current, baseline, event_type):
    panel = base.copy()
    deltas = delta_bins(current, baseline, event_type)
    panel = draw_delta_grid(panel, deltas)
    draw = ImageDraw.Draw(panel, "RGBA")
    draw_augusta(draw, panel.size)

    title_font = load_font(25, bold=True)
    meta_font = load_font(17)
    chip_font = load_font(15, bold=True)
    stats = delta_stats(current, baseline, event_type)
    local_start = dt.datetime.fromisoformat(current["local_start"])
    local_end = dt.datetime.fromisoformat(current["local_end"])
    date_label = local_start.strftime("%b %-d, %Y")
    count_key = f"{event_type}s"
    current_total = len(current[count_key])
    baseline_total = len(baseline[count_key])

    draw.rounded_rectangle((16, 16, 690, 118), radius=8, fill=(255, 255, 255, 228), outline=(210, 210, 205, 230), width=1)
    draw.text((30, 26), f"{current['title']} · {date_label}", fill=(25, 30, 35, 255), font=title_font)
    draw.text((30, 61), f"{local_start.strftime('%-I %p')}-{local_end.strftime('%-I %p')} PDT", fill=(60, 65, 70, 255), font=meta_font)
    draw.text(
        (30, 86),
        f"{event_type.title()} events {current_total} vs {baseline_total} prior · net {stats['net_delta']:+d} · max cell {stats['max_positive']:+d}/{stats['max_negative']:+d}",
        fill=(60, 65, 70, 255),
        font=meta_font,
    )

    legend_x = 20
    legend_y = panel.size[1] - 43
    draw.rounded_rectangle((legend_x, legend_y, legend_x + 486, legend_y + 27), radius=5, fill=(255, 255, 255, 224))
    draw.rectangle((legend_x + 12, legend_y + 8, legend_x + 32, legend_y + 20), fill=(204, 31, 38, 150), outline=(145, 24, 28, 170))
    draw.rectangle((legend_x + 147, legend_y + 8, legend_x + 167, legend_y + 20), fill=(29, 91, 181, 140), outline=(23, 69, 139, 155))
    draw.rectangle((legend_x + 282, legend_y + 8, legend_x + 302, legend_y + 20), fill=(122, 122, 122, 54), outline=(94, 94, 94, 100))
    draw.text((legend_x + 40, legend_y + 4), f"+ cells {stats['positive_cells']}", fill=(45, 45, 45, 255), font=chip_font)
    draw.text((legend_x + 175, legend_y + 4), f"- cells {stats['negative_cells']}", fill=(45, 45, 45, 255), font=chip_font)
    draw.text((legend_x + 310, legend_y + 4), f"0 cells {stats['neutral_cells']}", fill=(45, 45, 45, 255), font=chip_font)
    return panel


def render_map(results, event_type, output_path):
    base = build_basemap(MAP_BOUNDS, PANEL_SIZE)
    panels = [
        draw_panel(base, results["2026_masters"], results["2026_prior"], event_type),
        draw_panel(base, results["2025_masters"], results["2025_prior"], event_type),
    ]

    gutter = 28
    header_h = 116
    footer_h = 46
    width = PANEL_SIZE[0] * 2 + gutter * 3
    height = header_h + PANEL_SIZE[1] + gutter + footer_h
    image = Image.new("RGBA", (width, height), "#f3f1eb")
    draw = ImageDraw.Draw(image, "RGBA")

    title_font = load_font(38, bold=True)
    subtitle_font = load_font(19)
    small_font = load_font(14)
    title_word = "Takeoff" if event_type == "takeoff" else "Landing"
    draw.text((gutter, 24), f"Masters Sunday {title_word} Irregularity", fill=(24, 28, 32, 255), font=title_font)
    draw.text(
        (gutter, 72),
        f"Inferred {event_type} event count by ~{GRID_CELL_MILES:.0f} mi cell, Masters Sunday minus the previous Sunday. Red is positive, blue negative, gray neutral.",
        fill=(66, 70, 74, 255),
        font=subtitle_font,
    )

    positions = [(gutter, header_h), (gutter * 2 + PANEL_SIZE[0], header_h)]
    for panel, position in zip(panels, positions):
        image.alpha_composite(panel, position)
        draw.rounded_rectangle(
            (position[0], position[1], position[0] + PANEL_SIZE[0], position[1] + PANEL_SIZE[1]),
            radius=8,
            outline=(190, 188, 182, 230),
            width=1,
        )

    draw.text(
        (gutter, height - 34),
        "Detector uses ground/stopped-to-climb and descent-to-ground/stopped transitions, with low-altitude start/end fallbacks for coverage dropouts. Basemap: © OpenStreetMap contributors © CARTO.",
        fill=(76, 78, 80, 255),
        font=small_font,
    )
    image.convert("RGB").save(output_path, quality=95)


def serialize_bins(bin_payload):
    rows = []
    for (row, col), count in sorted(bin_payload["counts"].items()):
        lon0, lat0, lon1, lat1 = grid_cell_bounds(row, col)
        rows.append(
            {
                "row": row,
                "col": col,
                "bounds": [lon0, lat0, lon1, lat1],
                "count": count,
                "unique_aircraft": bin_payload["unique_aircraft"].get((row, col), 0),
            }
        )
    return {
        "cells": rows,
        "reasons": bin_payload["reasons"],
    }


def write_summary(results):
    payload = {
        "cell_size_miles": GRID_CELL_MILES,
        "detector": {
            "max_segment_gap_seconds": MAX_SEGMENT_GAP_SECONDS,
            "confirm_window_seconds": CONFIRM_WINDOW_SECONDS,
            "low_altitude_ft": LOW_ALTITUDE_FT,
            "ground_speed_kt": GROUND_SPEED_KT,
            "airborne_speed_kt": AIRBORNE_SPEED_KT,
            "climb_descent_ft": CLIMB_DESCENT_FT,
            "event_cooldown_seconds": EVENT_COOLDOWN_SECONDS,
            "min_groundish_run_seconds": MIN_GROUNDISH_RUN_SECONDS,
        },
        "windows": {},
        "comparisons": {},
    }

    for key, data in results.items():
        payload["windows"][key] = {
            "title": data["title"],
            "date": data["date"],
            "local_start": data["local_start"],
            "local_end": data["local_end"],
            "observed_aircraft": data["observed_aircraft"],
            "kept_points": data["kept_points"],
            "takeoff_count": len(data["takeoffs"]),
            "landing_count": len(data["landings"]),
            "takeoff_bins": serialize_bins(data["takeoff_bins"]),
            "landing_bins": serialize_bins(data["landing_bins"]),
        }

    for year in ("2026", "2025"):
        current = results[f"{year}_masters"]
        baseline = results[f"{year}_prior"]
        payload["comparisons"][f"{year}_masters_vs_prior"] = {
            "takeoff": delta_stats(current, baseline, "takeoff"),
            "landing": delta_stats(current, baseline, "landing"),
        }

    EVENT_SUMMARY.write_text(json.dumps(payload, indent=2), "utf8")


def main():
    tracked_keys = tracked_aircraft_keys()
    results = {}
    for spec in WINDOWS:
        print(f"Building events for {spec.key} ({spec.date})...")
        results[spec.key] = build_window_events(spec, tracked_keys)
        print(
            f"  observed {results[spec.key]['observed_aircraft']} aircraft, "
            f"takeoffs {len(results[spec.key]['takeoffs'])}, "
            f"landings {len(results[spec.key]['landings'])}, "
            f"downloads {results[spec.key]['downloaded_files']}"
        )

    render_map(results, "takeoff", TAKEOFF_IMAGE)
    render_map(results, "landing", LANDING_IMAGE)
    write_summary(results)
    print(f"Wrote {TAKEOFF_IMAGE.relative_to(ROOT_DIR)}")
    print(f"Wrote {LANDING_IMAGE.relative_to(ROOT_DIR)}")
    print(f"Wrote {EVENT_SUMMARY.relative_to(ROOT_DIR)}")


if __name__ == "__main__":
    main()
