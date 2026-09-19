# Roadmap — from "runs on my laptop" to premier public signal

**Strategic redesign, 5 September 2026, revised with Fable and Kimi:** the
continuous digital watch, agent tasking, and observation-first work sequence
are in [https://github.com/XyraSinclair/warning-watch/blob/main/NUCLEAR-WARNING-STRATEGY.md](https://github.com/XyraSinclair/warning-watch/blob/main/NUCLEAR-WARNING-STRATEGY.md).
The concrete collection register is
[https://github.com/XyraSinclair/warning-watch/blob/main/DIGITAL-SIGNAL-REGISTER.md](https://github.com/XyraSinclair/warning-watch/blob/main/DIGITAL-SIGNAL-REGISTER.md).
The implementation roadmap below records the aviation-anomaly approach. Its
statistical goals must not be read as validated nuclear-warning capability.

The initial continuous watch is implemented separately from the aviation
calibration roadmap. Its enabled sources, bounds, operator-only assessments,
and remaining coverage limits are documented in [OPERATIONS.md](OPERATIONS.md).

## State of the watch, 19 September 2026 (measured on the live box)

The project is renamed **warning-watch** to match its domain. This audit is the
baseline the climb below is judged against; every number was read from the live
system that day, not from documentation.

**Holding.** Ingestion 99.93 % slot completeness over 30 days on all three
aviation cohorts; 4,866 of 5,248 gamma stations armed, both networks fresh;
CBRN refresh, daily integrity-checked backups, tunnel, disk and load all
healthy; ntfy round-trip canary passing.

**Not infrastructure-grade.**

| # | Defect | Measurement | State |
|---|---|---|---|
| A1 | The page's only subscribe instruction named an invalid ntfy topic | `warning.watch` is not a legal topic; alerts published elsewhere | fixed 19 Sept |
| A2 | The page promised email, SMS and web push | no provider credentials on the box, no signup surface; the canary passes those channels by skipping them | claim removed 19 Sept; canary still reports a skip as `ok` |
| A3 | Public alert rate ~20× target | 20 public-tier alerts in 24 days (10 elevated, 8 high, 1 critical, 1 notice) against "roughly monthly"; 19 of 20 from takeoff detectors | open |
| A4 | `takeoff_anomaly` bypasses the 11 Sept ladder | severity comes straight from the concurrent emergency level; "4 takeoffs during emergency level 4" published as HIGH | open |
| A5 | Ladder still on fallback thresholds | 198 of the 500 scored slots it needs | open (time, or backfill the score record) |
| A6 | Count data scored as sigma | "5 takeoffs vs 0 expected, 5σ" on a near-zero baseline is not a rare event | open |
| A7 | Nightly self-test failed 10 consecutive nights unheard | takeoff replay fired 9 against a 0.2/day budget; the watchdog suppresses repeat pages while the problem set is unchanged | open |
| A8 | Alert copy leaks internal identifiers | `global_military_aircraft` in public text | open |
| A9 | Fresh-box bootstrap never enabled the CBRN or self-test timers | `deploy/bootstrap.sh` timer list | fixed 19 Sept |
| A10 | README station count unexplained | README: 17,384 EURDEP stations; live: 3,658 reporting | open |
| A11 | Public dashboard JSON exposed server filesystem paths | `page.dbPath` and `liveStatus.cachePath` in `/dashboard.json`, both sibling files and `/api/dashboard`; a 503 message named the snapshot path | fixed 19 Sept |
| A12 | The only off-box database copy is 20 days old | `xyra-sanctuary:/srv/sanctuary/backups/warning-watch/` holds one day, 2026-08-30 — before the CBRN layer existed, so `ews-cbrn.sqlite` and `ews-watch.sqlite` have no off-box copy; automation waits on a box→sanctuary credential | open |

### The climb, in order

Each rung closes before the next opens; each is judged by a number.

1. **Truthful surface** (A1, A2, A9 — done). Every sentence on the page is
   checked against the live system.
2. **Silence the aviation noise** (A3–A6, A8). Aviation alerts stay on the
   operator surface until the detector earns the public tier: route
   `takeoff_anomaly` through the empirical ladder, replace sigma on counts with
   a Poisson-tail score plus an absolute floor that scales with the baseline,
   backfill the score record so the ladder leaves fallback. Exit: the replay
   self-test passes and the 90-day public alert count is ≤ 3.
3. **A watchdog that cannot go quiet** (A7, A2's canary). A failure that
   persists escalates instead of being suppressed; a skipped channel reports
   `skipped`, never `ok`. Exit: an injected persistent failure re-pages on
   schedule.
4. **Nuclear monitoring worth the name.** Below.
5. **Published firing record.** Every public alert, its ladder, and its
   after-the-fact verdict on the page. Trust is the empirical alert frequency
   matching the advertised one.

### Nuclear monitoring: what exists, what is missing

Objectives, in priority order: (N1) a detonation or major release anywhere is
reported within the hour; (N2) near-zero false public alarms; (N3) open sources
only; (N4) posture change is visible to the operator before it is visible to
the public.

| Layer | Today | Gap |
|---|---|---|
| Ambient gamma | BfS + EURDEP mirror, hourly, coherence-gated | **Europe only.** Nothing over North America, East or South Asia, the Middle East |
| Detonation | USGS catalogue kept as verification only | No rule of its own: no test-site geofence, no use of the catalogue's explosion classifications |
| Facility events | NRC event notifications + reactor status | United States only |
| Official warning | NWS CAP nuclear / radiological / hazmat types, relayed verbatim at critical | United States only |
| Agency reporting | IAEA news (operator surface) | Latency unmeasured |
| Posture | special-mission aircraft presence (operator surface) | No baseline for strategic command-post or tanker activity |

Candidate sources, **each to be verified by a live fetch before it is designed
around** (none is asserted here as working): Safecast open API for gamma outside
Europe; Japan NRA monitoring posts; EPA RadNet near-real-time gamma (the
README and the section below say laboratory data only — re-check); national CAP feeds
beyond NWS; USGS event-type and depth fields against a geofence of the known
test sites. CTBTO IMS and IAEA USIE stay out: treaty- and member-restricted.

Order within rung 4: detonation rule first (one feed already ingested, highest
consequence, lowest false-alarm surface), then gamma coverage outside Europe,
then non-US official warnings.

## CBRN alarm layer (implemented 10 September 2026)

**Calibration correction, 11 September 2026.** The severity ladder was firing
about seven times more often than this document specifies — one public alert
every two days against a target of roughly monthly. The cause was treating
count series as if their tails were Gaussian: a 3.5-sigma departure on thirty
seconds of thought is not, on real takeoff data, a rare event. Every evaluated
slot's score is now recorded, severity thresholds are empirical quantiles of
that record with the allowed exceedance count annualised from the span actually
covered, a tier fires only on a strict exceedance of the (k+1)-th largest
score, and no tier is reported unless its threshold is strictly separated from
the one below. Until five hundred slots exist the ladder falls back to
5.0 / 6.5 / 8.0 and each event carries the ladder it was judged against. The
public tier also now excludes agency reports: a published outbreak bulletin is
a report, not one of our detections, and stays on the operator surface.

The system's product focus is CBRN risk, and the instrument that carries it is
the deterministic alarm layer documented in [CBRN-WATCH.md](CBRN-WATCH.md):
open gamma telemetry, sampled civil air traffic over CBRN-relevant geographies,
public vocabulary bursts, and authority notices, all gated by a statistical
departure *and* an absolute physical magnitude, and all delivered through the
existing subscriber fan-out. Operations and verification commands are in
[OPERATIONS.md](OPERATIONS.md) § CBRN watch.

What this layer deliberately does **not** claim: prediction, global coverage,
or that a quiet instrument means safety. Its open work:

- **Warm-up is the current state.** The radiological detector arms per station
  after 48 hourly samples (two days) and the aircraft detector after ten
  same-hour samples over 21 days. Until then both report `warming`.
- **Radiation coverage is European** because no open global network exists.
  EPA RadNet publishes laboratory data rather than near-real-time telemetry;
  CTBTO's IMS network is treaty-restricted; ProMED moved behind a subscription.
- **The BfS EURDEP mirror needs lag monitoring.** It is a national regulator's
  republication of a European feed whose authoritative JRC service was stale.
- **Vocabulary coverage is one post stream and one news index**, and its
  latency advantage over official reporting remains a hypothesis to measure,
  not an established fact.
- **Alarm calibration is unproven until it has seen a real event.** The
  thresholds are defended by measurement and physics, not by a record of
  correct alerts. The first year of firing history is the evidence that will
  matter, and it should be published.
- **The fusion pass has had no live multi-family agreement yet.**

## 0. The contract (the whole system in one sentence)

> **One Hetzner box checks public ADS-B archives every two minutes, scores each
> new 30-minute source observation against a seasonal baseline, and pushes
> evidence-backed alerts while reporting its own failures. Genuine two-minute
> observations require a live source and validated source-specific calibration.**

Everything below either serves that sentence or gets cut. Corollaries:

- One machine, one SQLite file per cohort, one systemd timer chain. No workers,
  no D1, no queues, no split-brain between `server/` and `functions/`.
- The signal is only as valuable as its **calibration**: a doom signal that
  cries wolf dies; one that stays silent through a real anomaly never mattered.
  Trust = empirical alert frequency matches the advertised frequency.
- Subscribers must be able to distinguish "no alert" from "system dead" without
  thinking about it. Liveness is part of the product.

## 1. Properties the system must satisfy

### Signal integrity (S)
- **S1 — Data-quality gating.** A feed outage, coverage drop, or ADSBx format
  change must read as "data problem," never "elites fleeing." Every slot gets a
  denominator check (global aircraft seen, cohort match rate, slot availability)
  before any anomaly math runs. Most false alarms in systems like this are feed
  artifacts; L0 gating is the highest-leverage false-alarm control.
- **S2 — Seasonal honesty.** Business-jet activity has huge diurnal, weekly,
  and calendar structure (Davos, Sun Valley, the Masters, holidays). Baselines
  must condition on (day-of-week × slot-of-day) at minimum. *Current defect:
  the takeoff-rate model pools all 48 daily slots over 28 days into one
  mean/σ — night slots dilute the baseline and every morning wave looks hot.*
- **S3 — Robustness.** Median/MAD (or winsorized moments), not raw mean/σ —
  one prior anomaly must not poison the baseline that judges the next one.
- **S4 — Anytime validity.** We test every 30 minutes forever; naive p-values
  guarantee false alarms. Sustained-shift detection (CUSUM/Page-Hinkley) plus
  conformal or e-process scoring keeps the false-alarm budget explicit.
- **S5 — Tail calibration.** Top severities expressed as return periods via
  extreme-value fit (POT/GPD) on historical scores: "this level recurs about
  once every N years" is the profound, honest framing of an exodus signal.
- **S6 — Corroboration for the top rung.** Level-5 requires k-of-n independent
  evidence: business jets + military + non-ICAO dark traffic; geographic
  departure clustering (capitals, financial centers); destination anomaly
  (one-way legs to remote strips). One cohort alone caps at level 4.
- **S7 — Evidence attached.** Every alert carries its numbers: score, return
  period, contributing aircraft, baseline sparkline, permalink. No vibes.

### Delivery reliability (D)
- **D1 — Deduplicated evidence and delivery state.** Unique event keys and
  cursors prevent repeat scoring; external delivery after a lost acknowledgment
  can be uncertain and must not be described as guaranteed exactly-once.
- **D2 — Channel independence.** RSS, ntfy, Telegram, email, web push fail
  independently; one provider outage never blocks the others.
- **D3 — Synthetic end-to-end canary.** Weekly injected test event must reach
  a canary subscriber on every channel within SLA, else the operator is paged.
  A rarely-firing alert system that isn't continuously self-tested is dead
  code with a subscriber list.
- **D4 — Dead-man switches everywhere.** Every timer pings healthchecks.io
  (or self-hosted equivalent); silence pages the operator. Public status page
  + `last_slot_ingested` timestamp on the site.
- **D5 — Graceful degradation.** Missing provider config = channel disabled +
  visible in status, never a crashed pipeline (already largely true).

### Subscriber lifecycle (L)
- **L1 — Double opt-in** on email/SMS; one-click unsubscribe; List-Unsubscribe
  header; instant honor of STOP.
- **L2 — Auto-hygiene.** Bounces/complaints prune automatically. No manual
  list gardening, ever.
- **L3 — Privacy.** Contacts encrypted at rest (already: NOTIFICATION_ENCRYPTION_KEY),
  deletable on request, never shared. Data minimization: email or phone, nothing else.
- **L4 — Abuse resistance.** Rate-limited signup, no signup bombing (verify
  before store), CAPTCHA only if attacked (keep friction minimal until then).

### Operations (O)
- **O1 — One-box simplicity.** Hetzner CPX11/CX22 (~€5/mo), Debian or NixOS,
  systemd timers, Caddy TLS, SQLite + Litestream/restic offsite backup.
- **O2 — 30-minute rebuild.** Documented, tested restore-from-scratch: fresh
  box → running system in ≤30 min (script it: `bootstrap.sh`).
- **O3 — <30 min/month maintenance.** Unattended upgrades, auto-restart,
  meta-monitoring. No component that needs babysitting survives review.
- **O4 — Feed independence.** ADSBx free heatmaps could vanish. Ingest behind
  an interface with a second source ready (adsb.lol / airplanes.live /
  OpenSky). Alert on feed divergence, don't scramble later.

### Public-facing honesty (P)
- **P1 — The copy never claims prophecy.** "Business-jet activity is at a
  level seen roughly once per N years" — an anomaly report, not a doom oracle.
  Methodology page public. Base rates in every alert.
- **P2 — Calibration published.** Backtest results, historical alert log, and
  false-alarm record on the site. Trust through evidence.
- **P3 — Legal floor.** Informational service, no warranty; CAN-SPAM/GDPR
  basics (unsubscribe, deletion, minimal data). Free tier keeps this simple.

## 2. The statistical layer, concretely

Layered detector, each layer gating the next:

```
L0 data-quality gate      slot coverage, cohort match-rate, feed freshness
L1 seasonal baseline      per (dow × slot) robust location/scale (median/MAD),
                          trailing 8-12 weeks, trend-adjusted
L2 sequential scoring     residual → conformal p / e-value; CUSUM for sustained
                          shift (an exodus is sustained, not one hot slot)
L3 tail calibration       POT/GPD on years of scores → return periods;
                          severity ladder = target frequencies:
                          watch ~weekly · elevated ~monthly · high ~quarterly ·
                          critical ~yearly · emergency = beyond observed record
L4 corroboration          k-of-n across cohorts + geography + destination
                          entropy before the top severities
```

**Backtest is the acceptance test for all of it.** The 365-day backfill
(`backfill_history.py`, run it on the Hetzner box, not the laptop) replays a
year through the detector; the empirical alert-frequency table must match the
ladder above, and known mass-flight calendar events (Davos, Super Bowl, the
Masters — we already build Masters flight maps) must NOT breach `high`.
Wire as a CI job: `npm run backtest` → frequency table → fails if drifted.

## 3. Channel strategy (simpler than Twilio — mostly: skip SMS at launch)

The honest answer on SMS: the vendor isn't the complexity — **SMS itself is**
(A2P 10DLC registration, carrier filtering, per-message cost, STOP compliance).
Telnyx is already wired if we ever want it. Launch without it.

| Channel | Cost | Maintenance | Verdict |
|---|---|---|---|
| RSS | 0 | none | live already; keep |
| **ntfy.sh** | 0 (or self-host on the same box) | ~none | **flagship push**: subscribers install ntfy app, subscribe to topic; no accounts, no vendor contract |
| Telegram channel | 0 | ~none | one BotFather token; huge reach |
| Email (Postmark or SES) | ~free at our volume | low | double opt-in list; Postmark is dramatically simpler than SendGrid |
| Web push (VAPID) | 0 | low | keys already generated |
| SMS (Telnyx) | $ + compliance | **high** | deferred; paid tier later if demanded |
| Stripe paid tier | — | medium | **cut from launch.** Free removes Stripe webhooks, renewal reminders, customer portal — a third of the notification codebase |

## 4. Architecture end-state (the Hetzner consolidation)

Today there are two parallel implementations: the Express server + scripts
(local) and the Cloudflare Pages functions + D1 + maintenance worker
(production-intended). Premier state keeps **one**: the Express/scripts stack,
moved to the box. The CF stack (functions/, workers/, wrangler) gets retired
or frozen — deleting a parallel implementation is the single biggest
maintenance-cost reduction available.

```
Hetzner box (~€5/mo)
├── systemd timer: refresh (10 min)  → ingest → detect → fanout → feeds
├── systemd timer: backfill-repair (daily, self-healing gaps)
├── systemd timer: canary (weekly synthetic event, all channels)
├── systemd service: express server (site, RSS, signup, status)
├── Caddy (TLS, rate limiting)
├── Litestream → object storage (continuous SQLite replication)
└── healthchecks.io pings from every timer
```

DNS on the existing domain or a new one; Cloudflare proxy in front optional
(free tier) for DDoS comfort.

## 5. Phases with exit criteria

> **State checkpoint 2026-08-28.** Live at <https://warning.watch> (apoc.watch,
> earlywarning.watch redirect). Box: xyra-dev-hetzner, systemd chain
> (refresh/imports/repair/watchdog/backup timers + server + cloudflared +
> self-hosted ntfy), all watched by `status.js` → hourly ops-ntfy watchdog.
> Done since the plan was written: 5-week ADSBx outage repaired (Referer
> header), self-healing gap repair incl. interior holes, daily
> integrity-checked `VACUUM INTO` backups + restore drill, double opt-in
> email/SMS (L1 ✅), signup rate limiting (L4 ✅), write-authed self-hosted
> ntfy (spoof vector closed), tunnel serving with zero open inbound ports,
> site onboarding copy (Get Alerts / How To Read / Methodology).
> **Phase 2 exit: met** (box-only for weeks; restore drilled;
> `deploy/bootstrap.sh` written 2026-08-28 from live box state, unit files
> byte-verified against production — a fresh-box drill would need a new
> Hetzner instance, i.e. new spend). **Phase 3: ntfy + RSS + web push live;
> email needs a provider account (operator gate); Telegram needs one phone
> step; weekly public-path canary live.**
>
> **Phase 1 update 2026-08-28.** Landed: seasonal (weekday-class × slot)
> median/MAD takeoff-rate baseline with source-consistent counting (the old
> model mixed the live slot-transition process with ~45×-denser trace
> backfill — a repair pass touching the current window would have
> manufactured a false critical; S2's pooled-seasonality critique was the
> smaller half of the defect), L0 feed-volume gate over new `ingest_slots`
> provenance (S1), CUSUM `sustained_shift` layer (S4), and
> `npm run backtest` replaying production code paths with the 3×-exodus
> injection test. The concurrent model kept its architecture (dow×slot
> baselines, holiday calendar, peak-calibrated thresholds) but its slot
> stats moved from mean/stdDev to median + scaled MAD: with one sample per
> week per slot, the live exodus being scored sat in its own baseline
> group and a 3× injection self-dampened to σ2.4 (level 3) — under robust
> stats the same injection scores σ27.9 and fires level 5 in the first
> slot. The backtest caught this live-model defect; both cohorts now pass
> the injection exit criterion. CUSUM defaults tuned on 66 days of box
> data (k=1.5 h=12 crit=20: high on exactly the two hottest real sustained
> days, never critical on history, S≈13 within an hour of a 3× exodus).
> Liveness provenance (`live_ingested`) gates the takeoff baseline so the
> 08-13→08-26 live-ingestion gap cannot contaminate medians (was 16 false
> criticals/30d, now 2 watch-tier fires/30d, p99 z 3.04).
> 365-day backfill completed 2026-08-29; history now reaches 2025-08-29.
>
> **Instrument bounds 2026-08-29.** Every alarm limit now has a written
> basis (OPERATIONS.md "Instrument bounds") and continuous enforcement:
> status.js accounts for every expected slot (live/backfilled/missing,
> 98 % completeness bound, 75-min live-age bound, 42/48 live-coverage
> bound), the watchdog runs every 10 min (infra failure pages in ~85 min
> worst case, was ~3 h), and a nightly selftest timer replays the backtest
> with `--assert` so detector drift pages within a day. First run of the
> bounds caught three real defects (a 'T'-vs-space SQL window bug, the
> untracked cohort's unwired live provenance, and — via the deepening
> backfill — CUSUM burning 9 false criticals on unlearned first-year
> holiday travel waves, now gated by a self-expiring calendar freeze).
> Both cohorts pass all bounds; concurrent threshold self-calibrated to
> 11.1σ over 270 days with exactly one level-5 day (Dec 27).

**Phase 0 — local operational.** ✅ 2026-07-03. Signal computes on live data,
10-min loop + always-on server under launchd, RSS + owner push live, smoke
suite green, baselines healing.

**Phase 1 — statistical hardening.** ✅ 2026-08-30. Seasonal (dow × slot)
robust baselines; L0 data-quality gate; CUSUM sustained-shift layer; 365-day
backfill on server hardware; backtest harness with frequency table +
calendar-event non-alarms; severity ladder recalibrated to target
frequencies.
*Exit met on the full 365-day history: nightly `backtest --assert` green on
both cohorts; a simulated 3× exodus reaches HIGH ≤ 60 min and CRITICAL
≤ 120 min (recalibrated 2026-08-30 — one 3× slot reads ~9.7σ against an
~11.2σ self-calibrated alarm line, so sustain via CUSUM is the honest
critical path; the year's hottest real day, Dec 27, hit 12.1σ); Davos-week
replay stays below level 4 — every top-10 hottest day is a holiday travel
wave (cutoff σ7.74).*

The 2026-09-05 assurance correction aligns takeoff history and targets on the
final-slice clock and removes a one-slot seasonal phase error without loosening
limits. Business and military pass the current existing replay window. Non-ICAO
now preserves global coverage evidence and uses a relative-count calibration
profile without changing the other cohorts or alarm bounds. Its latest injection
passes, but frozen-model evaluation still shows low-count blind spots and its
takeoff replay remains warming. OPERATIONS.md records the denominators, moving-
window limitation, inferred historical liveness, and unchanged cohort filtering.

**Phase 2 — the box.** Hetzner provisioned by `bootstrap.sh`; systemd chain;
Litestream backups; healthchecks on every timer; restore drill done twice;
laptop demoted to dev machine.
*Exit: laptop off for 72h, system green; rebuild-from-scratch ≤ 30 min.*

**Phase 3 — subscription surfaces.** ntfy topic + Telegram channel + Postmark
double-opt-in email + web push; status page with last-ingest timestamp and
historical alert log; weekly synthetic canary paging on failure; methodology
page.
*Exit: canary delivered on all channels 4 weeks running; signup → verify →
unsubscribe loop tested by a stranger.*

**Phase 4 — share it.** Soft launch to trusted circle → public. Publish
calibration receipts. Iterate on the copy until it is impossible to read an
alert as a prophecy rather than a measurement.
*Exit: strangers subscribed; zero uncalibrated alerts; ≤30 min/month observed
maintenance for a full month.*

**Deliberately cut (revisit only on demand):** Stripe/paid tier, SMS, the
Cloudflare Pages/D1 stack, multi-region redundancy, user accounts, per-user
thresholds.

## 6. Standing risks

| Risk | Mitigation |
|---|---|
| ADSBx free endpoint closes | O4 second-source interface; alert on divergence |
| False alarm goes viral | P1 copy discipline; return-period framing; corroboration gate on top severities |
| Silent death (worst failure for an EWS) | D3 canary + D4 dead-man switches + public status |
| Baseline poisoned by slow drift | robust stats + trend term + quarterly backtest re-run |
| Solo-operator bus factor | O2 scripted rebuild; everything in git; OPERATIONS.md current |
