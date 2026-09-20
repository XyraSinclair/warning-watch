# Warning Watch

A continuous public-source watch built to alert people to **CBRN risk** —
chemical, biological, radiological and nuclear. Its instruments are open gamma
dose-rate telemetry, sampled civil air traffic over CBRN-relevant places,
out-of-distribution bursts in public vocabulary, and authoritative CBRN
notices. Machine investigations and a private operator review sit behind those
measurements.

The watch reports what changed and what remains unverified. It does not estimate
the probability of nuclear use, infer intent from aircraft activity, or treat
quiet sources as evidence of safety. Alerts carry the measurement, its
uncertainty, the strongest alternative explanation, and what a person should do.
See [CBRN-WATCH.md](CBRN-WATCH.md) for every alarm rule and its thresholds.

Earthquakes, storms and other natural disasters are deliberately **not** the
product. Seismic catalogues are retained only as explosion verification, and
weather-service alerts are relayed only when they are CBRN events.

## How it works

```
21 public-source definitions ──► observations, revisions, source health
        +                        │ semantic changes
  7 CBRN authority feeds         ▼
                          persistent incident threads
                                 │ bounded investigations
                                 ▼
                        specialist + skeptic → synthesis
                                 │
                                 ▼
                     private operator review + next questions

CBRN instruments ──► deterministic detectors ──► alert_events ──► subscribers
 gamma telemetry       baselines + CUSUM            │        ntfy · RSS · Telegram
 air traffic           absolute physics gates       │        email · SMS · web push
 vocabulary bursts     spatial coherence            └── fusion escalates agreement
 official notices      (no baseline → no alert)
```

- **Two gates on every public alert**: a statistical departure *and* a physical
  magnitude. A four-sigma drift on a quiet probe stays operator-only.
- **Detection is evidence-bound**: no baseline → no alert. Missing or stale data
  means the instrument is unavailable, never that the world is safe.
- **Keyed fanout with a firing record**: repeated samples do not create new
  statistical evidence; an event that rises to a higher public severity is
  delivered again, and every delivery is a row in `publications`. External
  delivery can remain uncertain after a lost acknowledgment.
- The aviation instrument keeps its own calibration and publishes dashboard
  JSON at `/dashboard.json`, `/military-dashboard.json` and
  `/untracked-dashboard.json`:
  ADS-B Exchange public heatmaps (30-minute source slots, checked every 2
  minutes) scored against seasonal baselines for three cohorts.
- The full pipelines are two commands (`npm run refresh:all`, `npm run
  cbrn:refresh`), designed to run from any scheduler on one cheap box.

## The CBRN instruments

| Instrument | Measurement | Coverage | Cadence |
|---|---|---|---|
| Radiological telemetry | Gamma dose rate per station | 1,676 German probes + a live EURDEP mirror of 17,384 stations in 44 countries (BfS/IMIS OGC service); EPA RadNet's 140 US monitors | hourly |
| Civil air traffic | Aircraft counts, emergency indications, special-mission type presence | 14 public CBRN-relevant geographies + 2 health controls | 5 min |
| Public vocabulary | CBRN event-word counts by place | one public post stream + one news index | hourly |
| Official notices | CBRN alerts and instructions | NWS CAP, NRC events and reactor status, FAA TFRs, WHO, ECDC, IAEA, HealthMap | 10 min – 1 h |

Public alerts appear on the single page at `/` and are pushed through the same
channels as the aviation instrument. The highest-value alert in the system is
not ours at all: an actual *Nuclear Power Plant Warning* or *Radiological
Hazard Warning* CAP message is relayed at critical severity, a *Hazardous
Materials Warning* at high, with the issuing authority's own instruction text
verbatim.

## Quickstart

```sh
npm ci
cp .env.example .env          # defaults work for local use
npm run refresh:all           # ingest latest slot, detect, export feeds
npm run cbrn:refresh          # collect CBRN instruments, run detectors, fuse
npm run watch:run -- --collect-only  # collect enabled public sources without inference
npm run build && npm start    # CBRN, watch, aviation and RSS at http://127.0.0.1:3030/
```

`npm run cbrn:refresh` needs no credentials: every CBRN instrument is a public
endpoint. The radiological instrument needs 48 hourly samples per station before
it can alert, so it reports `warming` for the first two days; the aircraft
instrument needs 10 same-hour samples over 21 days. Until then those detectors
emit nothing, by construction.

Python 3 with `numpy` and `Pillow` is needed for ingestion
(`pip install -r requirements.txt`). Baselines need ~7 days of history before
anomaly models arm; `scripts/backfill_history.py --start-date … --end-date …`
fills history from public archives. Polling every two minutes does **not**
make those 30-minute archives a real-time feed. Genuine two-minute observations
require an authorized live global source and separately validated calibration.

Node 22 or newer is required for the watch's built-in WebSocket client.
Automatic investigations use an existing funded `SCRY_API_KEY`; keep it in a
private environment file and set `EWS_WATCH_ENV_PATH` when running locally.
The supported model is `google/gemini-2.5-flash-lite`, with a $0.10 provider-usage
allowance per UTC day. Reports enter bounded batch screening before full,
three-role investigation; official notices bypass that admission stage.
Missing inference credentials do not stop source collection. Production uses
the separate `/etc/warning-watch-sources.env`, read only by the watch service.

The registry contains 46 definitions, including ten country-specific travel
advisories: 28 enabled and 18 explicitly inactive or access-gated. These are
not 46 independent instruments or all 64 candidate observables in the planning
register. Predictive validation remains outside the implemented watch: what is
implemented is measurement, baseline and disclosure, not foresight.

## Subscribing (for a running deployment)

| Channel | How |
|---|---|
| ntfy push | install the [ntfy](https://ntfy.sh) app, subscribe to the deployment's topic |
| RSS | `<deployment>/rss.xml` in any feed reader |
| Telegram | join the deployment's channel |
| Browser push | the front page's sign-up panel |
| Email / SMS | the same panel, once the deployment sets its Postmark token and sender, or its Telnyx key and number |

## Operations

See [OPERATIONS.md](OPERATIONS.md) for deployment, resource bounds, access, and
recovery. [CBRN-WATCH.md](CBRN-WATCH.md) defines the CBRN instrument rules and
every alarm threshold. [NUCLEAR-WARNING-STRATEGY.md](NUCLEAR-WARNING-STRATEGY.md)
and [DIGITAL-SIGNAL-REGISTER.md](DIGITAL-SIGNAL-REGISTER.md) retain the wider
design and candidate-source register. [ROADMAP.md](ROADMAP.md) records the
aviation instrument's calibration work, not validated nuclear-warning
capability.

## Provenance

This is an independent recreation, with a self-hostable backend, inspired by
[Kyle McDonald's Apocalypse Early Warning System](https://ews.kylemcdonald.net/).
It is not affiliated with or endorsed by the original. Aircraft data comes from
ADS-B Exchange's public interfaces; live point queries in the CBRN aircraft
instrument use [adsb.lol](https://adsb.lol) under the ODbL. Gamma telemetry is
republished by the German Federal Office for Radiation Protection (BfS) through
its public OGC service.

## License

MIT — see [LICENSE](LICENSE).
