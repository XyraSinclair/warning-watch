# CBRN watch — what this system alerts on, and what it refuses to claim

**Design and alarm rules · 10 September 2026 · Not a current threat assessment**

This is the alarm layer of warning.watch. The rest of the repository describes a
broad public-source watch of official decisions, public reporting and civil
signals. This document is narrower and stricter: it is about the small set of
measurements this system is willing to wake a stranger for, the thresholds that
have to be crossed, and the things it will never claim.

The instrument exists because the historical record offers almost no honest
public precursor to a deliberate release, but it does offer several honest
*measurements* of a release once one is under way — and a few behavioural
signals that sometimes move before official reporting does. The product is
therefore not prediction. It is a faster, better-instrumented path from "a
physical thing changed" to "a person knows, with the uncertainty stated."

## 1. Four instrument families, one alarm plane

| Family | What is measured | Source | Cadence |
|---|---|---|---|
| **Radiological telemetry** | Gamma dose rate per station, µSv/h | German BfS/IMIS OGC service: the 1,676-probe German network (`opendata:odlinfo_odl_1h_latest`) and the live EURDEP mirror, 17,384 stations in 44 countries (`opendata:eurdep_latestValue`); EPA RadNet, 140 fixed monitors across the United States, 131 with a dose rate, one per city (per-monitor monthly CSV) | hourly |
| **Civil air traffic** | Aircraft count, emergency indications and special-mission type presence in 14 CBRN-relevant geographies plus 2 health controls | `api.adsb.lol` point queries, public ADS-B | 5 min |
| **Public vocabulary** | Counts of CBRN event words by place, per hour | the watch's public post stream and news index | hourly buckets |
| **Seismic** | Underground detonation candidates: location against the seven test sites where a test remains possible, depth, and the agency's classification | USGS ComCat significant-week and all-day feeds | 5 min |
| **Authority** | Official CBRN notices and instructions | NWS CAP (radiological/hazmat/nuclear-plant events), NRC event notifications with emergency class, NRC reactor power, FAA TFRs, WHO Disease Outbreak News, ECDC CDTR, IAEA news, HealthMap | 10 min – 1 h |

All four families write into one table — `alert_events` with `cohort='cbrn'` —
and the existing fan-out carries them out: ntfy push, RSS, Telegram, email,
SMS, web push and outbound webhook. There is no second delivery path to keep
alive, and the two-minute aviation pipeline delivers CBRN events within two
minutes of them being written.

Severity keeps its repository-wide meaning: `watch` stays on the operator
surface; `elevated`, `high` and `critical` reach subscribers.

## 2. The two-gate rule

Every public severity must pass **both** gates:

1. **Statistics** — how unusual is this against the instrument's own history?
   Robust median/MAD baselines, sequential CUSUM for persistence, never a
   single sample alone.
2. **Physics** — is the magnitude actually meaningful? A modern gamma probe
   drifts four sigma while measuring nothing, and a quiet regional airport
   posts zeros all night.

A statistically extreme but physically trivial departure can never rise above
`watch`. This is the single most important rule in the layer: without it, a
17,000-station network polled hourly produces a permanent false alarm.

## 3. Radiological ladder — the discriminator is coherence

The denominator is the whole problem. With ~17,000 stations, thousands of
statistical tail events occur every hour by construction. What separates a
release from an instrument fault is that a release *moves neighbouring stations
together*.

| Condition | Severity |
|---|---|
| 1 station departs (≥3× its own 30-day median **and** ≥+0.5 µSv/h, or ≥5 µSv/h outright) | `watch` |
| 3–4 genuinely distinct stations within 50 km depart coherently | `elevated` |
| ≥5 coherent stations | `high` |
| coherent cluster containing ≥10 µSv/h at any station, or ≥15 stations | `critical` |

Reference scale, stated in the code: ordinary outdoor dose rate is
0.05–0.25 µSv/h; rain and radon washout can transiently double it; a real
release drives stations to 1–100 µSv/h. A station needs 48 samples before it can
alert at all; below that it reports `warming` and emits nothing. At most one new
public radiation cluster may fire per six hours; suppressed ones are recorded at
`watch` with the suppression named in the payload.

A network that stops answering for three consecutive polls emits a
`watch`-level availability event. Blindness is visible; it is never an
all-clear.

**Sparse networks ask agreement of time instead of space.** EPA RadNet is one
monitor per city, hundreds of kilometres apart, so no monitor has neighbours
to move with. Its record (measured 19 Sept 2026: 131 dose-rate monitors,
1.59 million hourly readings since January 2025) has a highest hour of
0.32 µSv/h and a highest ratio to a monitor's own median of 5.75× (radon
washout in rain): the station threshold above was met zero times. So on RadNet
one departing hour is `elevated` (the 95 % bound from that record is about two
a year across the network, inside the twelve-a-year budget), a second
consecutive hour or a second monitor is `high`, and ≥10 µSv/h held for two
hours is `critical`. An episode is keyed to its first hour, so the confirming
hour raises the same event. EPA publishes only hours it has approved, so a real
spike may be held for review before it appears: silence from RadNet is not an
all-clear, and the network's staleness is watched like the others.

## 4. Aircraft ladder — voids, not exodus

The aviation instrument asks a different question than the original
business-jet exodus detector. It does not infer intent, passengers or missions.
It watches whether the sky over a CBRN-relevant place stops behaving normally.

- A region requires 10 same-hour samples over 21 days and a baseline median of
  at least 15 aircraft before it can alert.
- A **traffic void** (≤25% of baseline, or z ≤ −5) fires at `watch`; sustained
  void with ≤10% of baseline across three consecutive samples reaches
  `elevated`.
- Both sampled **control** regions (Europe, US Midwest) must be healthy in the
  same sample, or the sample is discarded as a feed problem — never as a world
  event.
- An **emergency cluster** needs ≥3 aircraft with emergency indications and 3×
  the seven-day median; a **special-mission type** must appear in two
  consecutive samples. Both stay at `watch`.
- No event above `elevated` is ever produced by aircraft alone.

## 5. Vocabulary ladder — partial, biased, and labelled as such

Counts of CBRN event vocabulary by place. A burst needs ≥10 historical
same-hour samples for the place, ≥3 distinct posts, 3× the baseline median and
an absolute floor of 8 matched terms for `elevated`; ≥25 terms and ≥8 posts for
`high`. Never `critical` on its own. Every such alert says, in the message
itself, that it is a count of matched words on one platform or index, that
coverage is partial and platform-biased, and that this stream is not
established to precede official reporting.

## 6. Authority — the one alert that is not ours

An **actual, current** CAP alert of type *Nuclear Power Plant Warning*,
*Radiological Hazard Warning* or *Hazardous Materials Warning* is relayed at
`critical` with the issuing authority, the affected area, the expiry and the
authority's own instruction text verbatim. Nothing of ours replaces or re-words
their instruction. Every other CAP event type is excluded: this is a CBRN
instrument, not an all-hazards one.

NRC event notifications with an emergency class of *Alert*, *Site Area
Emergency* or *General Emergency* relay at `high`; everything else is `watch`,
because non-emergency NRC reports are routine and numerous. Reactor power drops
and airspace restrictions near a listed region are `watch` only.

## 6a. Seismic — the detonation rule

Every underground nuclear test since 2006 is in the USGS catalogue as
`nuclear explosion` at depth 0. The rule (`server/detonation-rule.js`,
sites in `config/nuclear-test-sites.json`) is three tiers, each measured
against the catalogue since 2000 on 19 Sept 2026:

- **USGS classifies the event `nuclear explosion`**: `critical`, anywhere. All
  six North Korean tests.
- **M ≥ 3.5 within a test-site geofence** (50 km; 60 km at Nevada): `high` if
  the depth is within 5 km of the surface or the type is `explosion`;
  if USGS has not yet constrained the depth (its 10 km placeholder), `high` at
  the three seismically quiet sites (Punggye-ri, Novaya Zemlya, Pokhran: no
  independent natural M ≥ 3.5 since 2000) and `elevated` at the four active
  ones; `watch` if the depth is determined and deeper than 5 km. In 26.7 years this is one
  `high` that was not a test (the M3.6 aftershock the 2017 test induced) and
  eight `elevated`, about one every three years, all placeholder-depth
  earthquakes near Lop Nur, Ras Koh and Kharan. A depth revision raises or
  clears each of them.
- **USGS classifies an event `explosion` at M ≥ 4**, anywhere: `elevated`.
  One in ten years, the April 2025 Kirzhach ammunition-depot blast.

Each catalogue revision is a new observation and the same event key, so a first
automatic solution that later gains a depth or a classification escalates in
place. Events older than seven days are history and never alert. The collector
keeps M ≥ 3.5 events inside a geofence that its usual M ≥ 4.5 filter would drop.

## 7. Fusion — coincidence across independent instruments

When two *different* instrument families report the same place and time — a
radiation cluster plus an airspace restriction, an official notice plus a
traffic void — the fused event is raised to `high`, or `critical` when an
official notice is one of the contributors. Two events from the same network
are not independent and never fuse. Fusion states plainly that agreement
raises confidence in the *observation*, not in its cause.

## 8. What this cannot see

- **Gamma coverage is Europe and the United States.** The European networks
  and EPA RadNet; nothing over East or South Asia, the Middle East, Russia or
  the southern hemisphere, because no open near-real-time network publishes
  there (Safecast's open API is volunteer, sparse and mostly stale; Japan's NRA
  posts have no data feed). A normal reading asserts nothing outside the
  monitored area.
- **Seismic sees underground tests at known sites.** An atmospheric or
  high-altitude burst leaves no catalogued event; a test at a site not listed
  is caught only when USGS classifies it; a test small enough to fall below the
  global network's threshold is missed. The catalogue's first automatic
  solution can lag the event by ten minutes to an hour.
- **Aircraft sampling is a fixed roster**, not a global picture, and says
  nothing about cargo, mission or passengers.
- **Vocabulary is not reporting.** It is a count of words on one platform and
  one index.
- **Nothing here predicts a release**, and silence is not safety. Every alert
  states what was measured, where, what would change the assessment, and what a
  person should do.
- **The system cannot confirm a cause.** It can only make a measurement
  impossible to miss.

## 9. Bounds and operations

One systemd timer (`warning-watch-cbrn.timer`, every five minutes) runs
`scripts/cbrn_refresh.js`: radiation ingest (self-limited to one poll per
network per 30 minutes), aircraft ingest, then the four detectors and the
fusion pass. Stages are failure-isolated and reported individually; a missing
stage script is a hard failure, never a silent skip. The pass is guarded by a
flock and a 240-second deadline.

`npm run status` reports CBRN health separately: run age, failed stages, each
network's station count and reading age, whether any network reported inside
four hours, and consecutive collection failures. The verdict treats a blind
radiological instrument as a problem, not as calm.

Every threshold in this document lives in code, not in prose: this file
describes the rules; the scripts enforce them.

## 10. Sources, attribution and limits of access

Gamma telemetry is republished by the German Federal Office for Radiation
Protection (BfS) through its public OGC service. The JRC's own EURDEP value
service was found stale and partly unavailable during design — its station
catalogue's timestamps froze at 2024-05-06, roughly sixteen months behind — so
the BfS mirror is the live path, and it must be watched for its own lag drift.
ADS-B data come from
`adsb.lol` under ODbL; attribution is required and the API's rate limits are
dynamic, so the collector sends at most one request per 1.2 seconds and backs
off on 429. NRC feeds require a non-browser User-Agent and intermittently deny
bursts; the registry's backoff covers it. CTBTO's IMS network is restricted by
treaty and is not used. ProMED moved its reports behind a subscription and is
not used. EPA RadNet's near-real-time gamma is read from its per-monitor
monthly CSV service (`radnet.epa.gov/cdx-radnet-rest`), 140 small requests an
hour; EPA publishes no monitor coordinates, so `config/radnet-monitors.json`
places each monitor at its city.
