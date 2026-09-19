#!/usr/bin/env python3

import datetime as dt
import pathlib
import sys
import tempfile
import types

import numpy as np

ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from track_non_icao_hex import SLICE_BEGIN_MARKER, build_takeoff_rows, replace_live_snapshot
from update_latest_heatmap import SOURCE, ingest_slot, open_db


def assert_condition(condition, message):
    if not condition:
        raise AssertionError(message)


def telemetry(hex_value, altitude="1200", lat=38.0, lon=-77.0, ground_speed=140.0):
    return types.SimpleNamespace(hex=hex_value, alt=altitude, lat=lat, lon=lon, gs=ground_speed)


def latest_slice(sampled_at, rows):
    return types.SimpleNamespace(timestamp=sampled_at, telemetry=rows)


def insert_live_snapshot(connection, hex_value, observed_at, is_airborne):
    connection.execute(
        """
        INSERT INTO live_snapshot (
          hex, registration, label, observed_at, lat, lon, altitude_ft, ground_speed_kt, track, is_airborne, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            hex_value,
            hex_value.upper(),
            hex_value.upper(),
            observed_at,
            38.0,
            -77.0,
            None if not is_airborne else 1200,
            0 if not is_airborne else 140,
            None,
            1 if is_airborne else 0,
            SOURCE,
        ),
    )


def count_takeoffs(connection):
    return connection.execute("SELECT COUNT(*) AS count FROM takeoff_events").fetchone()["count"]


def encoded_non_icao_point(hex_suffix, altitude_code, ground_speed_tenths=1400):
    point0 = 0x1000000 | hex_suffix
    point1 = int(38.0 * 1_000_000)
    point2 = int(-77.0 * 1_000_000)
    point3 = (ground_speed_tenths << 16) | (altitude_code & 0xFFFF)
    return [point0, point1, point2, point3]


def write_non_icao_cache_slices(cache_path, slices):
    values = []
    for timestamp_ms, point_rows in slices:
        values.extend([SLICE_BEGIN_MARKER, 0, timestamp_ms, 0])
        for point_row in point_rows:
            values.extend(point_row)
    np.array(values, dtype=np.int32).tofile(cache_path)


def write_non_icao_cache(cache_path, timestamp_ms, point_rows):
    write_non_icao_cache_slices(cache_path, [(timestamp_ms, point_rows)])


def assert_tracked_takeoff_requires_previous_ground_state():
    with tempfile.TemporaryDirectory(prefix="warning-watch-takeoff-ingest-") as temp_dir:
        db_path = pathlib.Path(temp_dir) / "ews.sqlite"
        connection = open_db(db_path)
        try:
            tracked_by_hex = {
                "aaaaaa": {"registration": "NAAAAA", "label": "NAAAAA"},
                "bbbbbb": {"registration": "NBBBBB", "label": "NBBBBB"},
            }
            connection.execute(
                "INSERT INTO tracked_aircraft (hex, registration, label, source) VALUES (?, ?, ?, ?)",
                ("aaaaaa", "NAAAAA", "NAAAAA", "smoke"),
            )
            connection.execute(
                "INSERT INTO tracked_aircraft (hex, registration, label, source) VALUES (?, ?, ?, ?)",
                ("bbbbbb", "NBBBBB", "NBBBBB", "smoke"),
            )
            insert_live_snapshot(connection, "bbbbbb", "2026-06-23T11:30:00+00:00", False)
            ingest_slot(
                connection,
                tracked_by_hex,
                latest_slice(dt.datetime(2026, 6, 23, 12, 0, tzinfo=dt.timezone.utc), [telemetry("aaaaaa")]),
                replace_live_snapshot=True,
            )
            assert_condition(
                count_takeoffs(connection) == 0,
                "First-seen airborne tracked aircraft was incorrectly recorded as a takeoff.",
            )

            connection.execute("DELETE FROM live_snapshot")
            insert_live_snapshot(connection, "aaaaaa", "2026-06-23T12:00:00+00:00", False)
            ingest_slot(
                connection,
                tracked_by_hex,
                latest_slice(dt.datetime(2026, 6, 23, 12, 30, tzinfo=dt.timezone.utc), [telemetry("aaaaaa")]),
                replace_live_snapshot=True,
            )
            row = connection.execute(
                "SELECT hex, previous_observed_at FROM takeoff_events ORDER BY id DESC LIMIT 1"
            ).fetchone()
            assert_condition(row["hex"] == "aaaaaa", "Ground-to-air transition did not create a tracked takeoff event.")
            assert_condition(
                row["previous_observed_at"] == "2026-06-23T12:00:00+00:00",
                "Tracked takeoff did not preserve the previous ground observation timestamp.",
            )
        finally:
            connection.close()


def non_icao_row(hex_value, is_airborne=True):
    return {
        "hex": hex_value,
        "registration": None,
        "label": hex_value.upper(),
        "source": SOURCE,
        "observed_at": "2026-06-23T12:00:00+00:00",
        "lat": 38.0,
        "lon": -77.0,
        "altitude_ft": 1200 if is_airborne else None,
        "ground_speed_kt": 140,
        "track": None,
        "is_airborne": 1 if is_airborne else 0,
    }


def assert_non_icao_takeoff_requires_previous_ground_state():
    first_seen_rows = build_takeoff_rows(
        [non_icao_row("aaaaaa")],
        {"bbbbbb": {"observed_at": "2026-06-23T11:30:00+00:00", "is_airborne": 0}},
    )
    assert_condition(first_seen_rows == [], "First-seen airborne non-ICAO row was incorrectly recorded as a takeoff.")

    ground_rows = build_takeoff_rows(
        [non_icao_row("aaaaaa", is_airborne=False)],
        {"aaaaaa": {"observed_at": "2026-06-23T11:30:00+00:00", "is_airborne": 0}},
    )
    assert_condition(ground_rows == [], "Ground non-ICAO row was incorrectly recorded as a takeoff.")

    takeoff_rows = build_takeoff_rows(
        [non_icao_row("aaaaaa")],
        {"aaaaaa": {"observed_at": "2026-06-23T11:30:00+00:00", "is_airborne": 0}},
    )
    assert_condition(len(takeoff_rows) == 1, "Ground-to-air non-ICAO transition did not create a takeoff.")
    assert_condition(
        takeoff_rows[0]["previous_observed_at"] == "2026-06-23T11:30:00+00:00",
        "Non-ICAO takeoff did not preserve the previous ground observation timestamp.",
    )

    airborne_rows = build_takeoff_rows(
        [non_icao_row("aaaaaa")],
        {"aaaaaa": {"observed_at": "2026-06-23T11:30:00+00:00", "is_airborne": 1}},
    )
    assert_condition(airborne_rows == [], "Already-airborne non-ICAO row was incorrectly recorded as a takeoff.")


def assert_non_icao_live_snapshot_persists_ground_state():
    with tempfile.TemporaryDirectory(prefix="warning-watch-non-icao-live-") as temp_dir:
        temp_path = pathlib.Path(temp_dir)
        db_path = temp_path / "ews.sqlite"
        ground_cache = temp_path / "ground.bin"
        airborne_cache = temp_path / "airborne.bin"
        connection = open_db(db_path)
        try:
            write_non_icao_cache_slices(
                ground_cache,
                [
                    (
                        900_000,
                        [
                            encoded_non_icao_point(0x000ABC, 48, ground_speed_tenths=1400),
                            encoded_non_icao_point(0x000DEF, 52, ground_speed_tenths=1300),
                        ],
                    ),
                    (1_000_000, [encoded_non_icao_point(0x000ABC, -123, ground_speed_tenths=20)]),
                ],
            )
            ground_result = replace_live_snapshot(connection, ground_cache)
            ground_row = connection.execute(
                "SELECT hex, is_airborne, altitude_ft FROM live_snapshot WHERE hex = ?",
                ("~000abc",),
            ).fetchone()
            assert_condition(ground_result["snapshot_rows"] == 1, "Ground non-ICAO live row was not retained.")
            assert_condition(ground_row["is_airborne"] == 0, "Ground non-ICAO live row was marked airborne.")
            assert_condition(ground_row["altitude_ft"] is None, "Ground non-ICAO live row retained an airborne altitude.")

            write_non_icao_cache(
                airborne_cache,
                2_000_000,
                [encoded_non_icao_point(0x000ABC, 48, ground_speed_tenths=1400)],
            )
            replace_live_snapshot(connection, airborne_cache)
            takeoff_row = connection.execute(
                "SELECT hex, previous_observed_at FROM takeoff_events WHERE hex = ? ORDER BY id DESC LIMIT 1",
                ("~000abc",),
            ).fetchone()
            assert_condition(takeoff_row is not None, "Parsed non-ICAO ground-to-air transition did not create a takeoff.")
            assert_condition(
                takeoff_row["previous_observed_at"] == "1970-01-01T00:16:40+00:00",
                "Parsed non-ICAO takeoff did not preserve the ground observation timestamp.",
            )
        finally:
            connection.close()


def main():
    assert_tracked_takeoff_requires_previous_ground_state()
    assert_non_icao_takeoff_requires_previous_ground_state()
    assert_non_icao_live_snapshot_persists_ground_state()
    print('{"ok":true,"checks":["tracked_takeoff_requires_previous_ground_state","non_icao_takeoff_requires_previous_ground_state","non_icao_live_snapshot_ground_transition"]}')


if __name__ == "__main__":
    main()
