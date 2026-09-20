# Operations — Warning Watch

The public surface combines a browser-local household alert plan, a separate
official-source notice display, and a continuous digital watch of observations,
immutable revisions, incident threads, bounded investigations, and handovers.
The existing aviation instrument publishes dashboard JSON only, with three aggregate
cohorts: `global_business_jet`, `global_military_aircraft`, and
`non_icao_untracked`. None establishes attack intent, safety, or successful
warning delivery to a resident.

## Re-entry protocol (start here after any absence)

The live deployment is on **xyra-dev-hetzner** at `/opt/dev/warning-watch`
(a git checkout of this repo's `main`; the laptop checkout is development
only — its launchd agents were retired 2026-08-27).

```sh
ssh xyra-dev-hetzner 'cd /opt/dev/warning-watch && npm run status'
```

`verdict.healthy` and `problems` retain the existing aviation/infrastructure
notification contract. Inspect `watch.healthy`, its source problems, run age,
agent availability, and service states separately for the digital watch.
Watch gaps also appear on the public surface; this release does not add new
ntfy, email, SMS, or Telegram messages. Aviation history repairs itself within
6 hours via the repair timer, or force it now:

```sh
ssh xyra-dev-hetzner 'systemctl start warning-watch-repair.service'
```

The two-minute watchdog pushes a plain-language note to the private ops ntfy
topic (`EWS_NTFY_OPS_TOPIC` in `/etc/warning-watch.env`) whenever the
verdict goes unhealthy, and a recovery note when it heals. Its own timer and
delivery path must also remain healthy; silence alone proves neither.

Everything above runs on the box, so none of it can report the box being gone.
The off-box dead-man (`config/deadman/`) runs on a second machine of ours as a user timer
every two minutes: it fetches `https://warning.watch/api/status` and pages a
public ntfy.sh topic when two consecutive fetches fail, the payload is
unreadable, or `aircraft.newestSample` is older than 8 minutes (the refresh
timer runs every 2). It pages on the transition, every 6 hours while dead, and
sends one recovery note. The topic URL lives only in
`~/.config/warning-watch/deadman.env` on that machine, never in this repo; the
script and units are copied to `~/.local/lib/warning-watch-deadman/` and
`~/.config/systemd/user/`. Proven 20 Sept 2026: two probes of a dead URL paged
inside a minute, the next live probe sent the recovery note.

A page must mean something, so the schedule is per problem (`decide` in
`ops_alert.js`, pure, runnable on a fake clock). A problem is identified by its
text with the numbers removed. It pages once it has lasted 3 minutes, again
every 6 hours through its first day, then at 24 hours and daily after at
`urgent` priority with its age in the title. It is over only after 10 minutes
of absence, so a flapping failure neither storms nor hides, and a one-run blip
pages nothing. One recovery note goes out when every paged problem has cleared.
The reason is the record: in the two weeks to 19 Sept 2026 the old
hash-of-the-whole-set rule sent about 150 pages (a false pair every night while
the backup was mid-write, bursts every two minutes from a minute counter in the
text), and the one real failure inside them went unacted-on for ten days.

Continuation work is tracked as beads: `br ready` lists what is unblocked
(see ROADMAP.md for the full arc).

## What runs on xyra-dev-hetzner (migrated 2026-08-27)

Systemd units — canonical sources in `config/systemd/` (incl.
`cloudflared.service`; ntfy config in `config/ntfy-server.yml`), installed to
`/etc/systemd/system/`. Config in `/etc/warning-watch.env` (not in git).
**Fresh-box rebuild: `deploy/bootstrap.sh`** (run as root on Ubuntu 24.04;
idempotent; installs packages/units from the canonical sources and prints
TODOs for the two secrets it cannot invent — the env file and the tunnel
token).

| Unit | What | Cadence |
|---|---|---|
| `warning-watch.service` | `server/index.js` Express server on 127.0.0.1:3030 | always on |
| `warning-watch-refresh.timer` | incremental pass (check archive → ingest new slot → snapshots/detection once per sample → retry delivery → feeds) | every 2 min, single active pass |
| `warning-watch-sources.timer` | `run_watch.js` — collect due sources, preserve revisions, investigate queued changes, write handover | every minute, one leased pass |
| `warning-watch-cbrn.timer` | `cbrn_refresh.js` — collect the CBRN instruments (gamma telemetry, sampled air traffic), run the four directional detectors and the fusion pass; writes alert events only, never deliveries | every 5 min, one flocked pass |
| `warning-watch-refresh-imports.timer` | same plus aircraft-metadata reimport | daily 00:29 |
| `warning-watch-repair.timer` | `repair_history_gaps.js` — self-heals trailing gaps AND interior holes across all three cohorts, bounded to 30 days | every 6 h |
| `warning-watch-watchdog.timer` | `ops_alert.js` — status verdict → ops ntfy topic (per-problem: 3 min hold, 6 h re-page, daily `urgent` from 24 h, recovery note) | every 2 min |
| `warning-watch-backup.timer` | `backup_databases.js` — `VACUUM INTO data/backups/<day>/` for all five DBs (three aviation cohorts, `ews-watch.sqlite`, `ews-cbrn.sqlite`), integrity-checked, 14 days kept; staleness feeds the existing status verdict. Restore requires stopping all relevant writers first. Off-box: manual sha256-verified copies land at `xyra-sanctuary:/srv/sanctuary/backups/warning-watch/<day>/` (automation pending a box→sanctuary credential) | daily 02:10 |
| `cloudflared.service` | Cloudflare tunnel (id `d27a04ac-5b8a-4d84-a4c9-ccf61978694d`; its label in the Cloudflare dashboard is still the pre-rename `apocalypse-ews` — cosmetic, the connector authenticates by id) — serves <https://warning.watch> from loopback:3030 and <https://ntfy.warning.watch> from loopback:2586 with no open inbound ports. Installed via `cloudflared service install <token>`; ingress config lives in the CF dashboard/API (`config_src: cloudflare`), not on disk | always on |
| `ntfy.service` | self-hosted ntfy 2.27.0 (`/etc/ntfy/server.yml`): loopback:2586, `auth-default-access: read-only`, user `publisher` has rw on both topics, `upstream-base-url: ntfy.sh` for iOS instant delivery. Auth DB `/var/lib/ntfy/user.db`. Box-side publishers use `EWS_NTFY_SERVER=http://127.0.0.1:2586` (loopback survives a tunnel outage; subscribers reconnect and receive cached messages) | always on |
| `warning-watch-canary.timer` | `canary_delivery.js` — synthetic end-to-end proof through the **public** path: site health, RSS, and an ops-topic ntfy publish polled back as a subscriber would. Deliberately the opposite path from the watchdog (loopback), so each pages when the other's path dies. Each check reports `verified`, `skipped`, or `failed`; email and SMS are `skipped` until a live-send canary exists, never ok. Failure leaves the unit `failed`, which the status verdict flags | weekly Mon 17:00 UTC |

**Public site: <https://warning.watch>** (apoc.watch and earlywarning.watch
301-redirect there). All three domains are on Xyra's Porkbun account with
nameservers at Cloudflare (zones on the Xyrasinclair@gmail.com account);
`EWS_PUBLIC_URL=https://warning.watch` in `/etc/warning-watch.env` makes
confirmation and management links absolute.

The public surface is **one page** at <https://warning.watch/>: current
instruments, the alert feed, the detection thresholds, and which baselines are
still warming, with the sign-up panel at its head. `/manage` is the one other
route, reached from a subscriber's own management link. Every former page
(watch, cbrn, aviation, plan, event-signals, signup) and its component source
was removed on 20 September 2026; git history holds it.

Endpoints (public via the tunnel, or loopback via `ssh -L 3030:127.0.0.1:3030
xyra-dev-hetzner`):

- Public page: <https://warning.watch/>; status data at `/api/status`
- Watch data: public `/api/watch` and `/api/watch/incidents/:id`
- Official-source notices: `/api/watch/official`, optionally `?state=CA`; independent of the private incident publication gate
- Aviation data: `/dashboard.json`, `/military-dashboard.json`, `/untracked-dashboard.json`
- Operator watch: `/api/admin/watch`, incident detail and review are token-gated by `INTERNAL_ALERT_TOKEN`; no page drives them.
- **RSS feed**: <https://warning.watch/rss.xml> — fires on emergency-level changes and alert events
- Ops/event feeds: `data/published/operations.json`, `event-signals.json`

Logs: `journalctl -u warning-watch-refresh` (and the other unit names).

Deploying a change: commit and push to `main`, then

```sh
ssh xyra-dev-hetzner 'cd /opt/dev/warning-watch && sudo -H -u xyra git pull --ff-only && sudo -H -u xyra npm ci --include=dev && sudo -H -u xyra npm run build && systemctl restart warning-watch.service'
# unit-file changes additionally need:
#   cp config/systemd/* /etc/systemd/system/ && systemctl daemon-reload
```

## Continuous digital watch

`server/watch-sources.js` is the executable source registry. The 21 enabled
definitions cover three existing aviation cohorts, ten GOV.UK advisories,
EASA conflict-zone bulletins, FAA airspace status, selected NWS civil warnings,
two USGS feeds, NOAA Kp, GDELT reporting, and Bluesky public post discovery.
Eighteen other definitions remain explicitly inactive or access-gated; an
inactive entry is not collection coverage. Source families and dependence
groups are not counts of independent corroboration.

The minute timer checks source-specific cadences, not every source every minute.
Four bounded collectors run concurrently; each request has a 25-second and
8-MiB ceiling. A pass is capped at 210 seconds, with a 270-second SQLite lease
and a 240-second systemd timeout. The Bluesky v2 stream starts at the live tail
on enrollment, then resumes an inclusive durable sequence. Each window stops
at 20 seconds, 8 MiB, 20,000 frames, or 500 relevant observations; its continuation,
coverage metadata, and backlog state remain visible. Only 200 matched records
are retained in its edit/delete tracking cursor. There is no pre-enrollment or
complete global-post coverage claim.
TLS connection establishment shares that same total 25-second deadline through
a pooled Undici dispatcher. The default 10-second connect limit was shorter
than the measured 10.09-second GDELT TLS handshake on the production host;
the change does not increase the overall request budget or weaken TLS checks.

Unchanged semantic content is deduplicated without advancing the observation
clock. Provider publication, observation, poll, and sample freshness are
separate clocks. Initial enrollment and replayed old reporting do not manufacture
new incidents. Official current civil alerts can be observed immediately.
CAP amendments/cancellations preserve all referenced predecessors; corrections
reach every linked incident without turning candidate context into corroboration.
Source disappearance, expiry, or a normal environmental measurement does not
establish an all-clear.

Failed sources retain structured failure state and bounded exponential backoff.
HTTP `Retry-After` is honored, including during forced passes. Successful recovery
clears that state. Poll cadence starts at the attempted check, not its completion;
stream progress and observation age remain distinct from collection success.

Investigations use `POST https://api.scry.io/v1/scry/openrouter` with the existing
funded Scry key. The production unit fixes `google/gemini-2.5-flash-lite` and a
$0.10 provider-usage allowance per UTC day. The ledger reserves worst-case cost
before a claim, reconciles reported usage, and retains reservations for unknown
usage after failures. Pricing is 100/400 nanodollars per input/output token;
other models are unavailable until explicitly supported and priced.

Each pass can screen up to sixteen report-only leads in one call, then run one
full investigation. Explicit fiction, art, history, games, or opinion without
a present-event claim can close machine work; uncertainty cannot. Official
notices bypass screening, and review/urgent work keeps priority. Within priority,
full investigations take the oldest waiting lead first. Full work consists of
independent specialist and skeptical calls followed by synthesis. Bounds remain
24 evidence records, 7,000 full-investigation evidence bytes, at most 24,000
request bytes, 1,600 output tokens per call, 45 seconds per call, and 100 seconds
total. Triage shares at most 24 evidence records and 18,500 evidence bytes across
the batch, retaining attribution and unabridged validity controls.

There are no model tools, arbitrary research URLs, automatic credential changes,
or unbounded recursion. Responses must have the configured served model, complete
finish reason, bounded fields, and exact own-item citations. Direct OpenRouter
uses strict JSON Schema; Scry uses validated JSON because that endpoint does not
offer the schema control. Invalid output fails visibly, never becomes a finding.
Returned partial usage is retained. Completed assessments update work priority;
machine-background/routine/correction outcomes close work, not the world.

Keep `SCRY_API_KEY` in root-owned mode-0600 `/etc/warning-watch-sources.env`;
systemd reads it before dropping privileges to `xyra`. Do not copy it into the
web-server environment, repository, browser, or logs. `EWS_WATCH_DAILY_BUDGET_USD`
can lower the $0.10 daily ceiling. This covers the fixed model's provider usage,
not a promise about third-party billing or unrelated account activity. Missing
funding, credentials, invalid responses, or timeouts leave investigations
visibly unavailable/failed; collection continues. A direct
`OPENROUTER_API_KEY` is supported only when explicitly configured without Scry,
not as a runtime fallback.

The incident APIs expose coverage, aggregate processing progress, and only source
evidence deliberately published by an operator, never raw queued reports,
machine assessments, or review notes. The separate official-notice API below
mirrors qualified NWS source messages without that publication gate.
Private review does not publish evidence.
Publishing requires approval of the exact current evidence generation; revisions
and newly attached candidate context invalidate that approval. Public filtering
happens before counts and pagination. Authentication is required to inspect
drafts, review, publish evidence, or resolve/reopen a thread. Resolving closes
review work; neither review nor publication establishes the claim or safety.
There is no publish-to-subscribers action.
The incident API accepts `status=open|resolved|all`, `limit`, and the opaque
`cursor` returned as `page.nextCursor`; the UI follows this continuation.

Watch state is isolated in `data/ews-watch.sqlite` with WAL, FULL synchronization,
foreign keys, and versioned migrations. Backup covers the watch as the fourth
database. To restore it, stop the watch timer, watch service, and web service,
preserve the existing database and sidecars, restore an integrity-checked copy,
then restart the web service and timer. Source cursors, evidence history,
incidents, reviews, daily attempt accounting, and handovers are in that file.
Retention prunes old unreferenced non-current evidence after 90 days; current
heads and incident-linked evidence remain. Collection failures preserve history
and cursor state rather than substituting empty successful results.

The watch is not predictive validation or a certified warning channel. Historical
case replay, broader source discovery/enrollment, a learned routine calendar,
validated official-warning relay, and public strategic assessment remain open
work. The current source registry and visible coverage gaps are the operational
truth, not the wider planning roster.

## CBRN watch

The CBRN instruments are a separate, deterministic layer: no model sits between a
measurement and the alert. Alarm rules and every threshold are in
[CBRN-WATCH.md](CBRN-WATCH.md); this section is the operational contract.

`warning-watch-cbrn.timer` runs `scripts/cbrn_refresh.js` every five minutes.
One pass: ingests gamma telemetry (self-limited to one poll per network per 30
minutes), ingests the live aircraft sample, then runs the radiation, airspace,
notice and vocabulary detectors and the cross-family fusion pass. Stages are
failure-isolated and each outcome is recorded in `data/cbrn-refresh-state.json`;
a missing stage script is a hard failure, never a silent skip. The pass is
guarded by `tmp/cbrn-refresh.flock` and a 240-second deadline.

**It never delivers.** Every CBRN event is a row in `alert_events`
(`cohort='cbrn'`) in `data/ews-main.sqlite`, and the existing two-minute refresh
pipeline's delivery stages carry it out — ntfy (elevated and above), RSS,
Telegram (level 5), subscriber email/SMS/web push, and the outbound webhook.
Expected end-to-end latency is therefore under two minutes, and there is exactly
one delivery path in the system.

State lives in `data/ews-cbrn.sqlite`: `cbrn_stations`, `cbrn_readings` (hourly
per-station dose rate), `cbrn_aircraft_slots` (per-region counts per 5-minute
sample), `cbrn_lexical_buckets` (counts and matched surface forms only — no post
bodies), `cbrn_regions` (the operator-controlled sampling roster),
`cbrn_alarm_state` (detector state and fusion windows), `cbrn_ingest_runs`
(collection health).

Fresh-box warm-up is real and must not be mistaken for a fault: the radiological
detector needs 48 hourly samples per station before a station can alert, and the
aircraft detector needs 10 same-hour samples over 21 days per region. Until then
both report `warming` and emit nothing. Only a severe, spatially coherent
departure can reach a public severity from the start, because the absolute
physical gate does not depend on the baseline.

Health is in `npm run status` under `cbrn`: run age (bound 15 minutes), failed
stages, per-network station counts and reading ages, whether any network
reported inside four hours, and consecutive collection failures (bound 6). The
verdict treats "no gamma network reported within four hours" as a problem — a
blind radiological instrument must never read as calm. The public picture is at
<https://warning.watch/>, backed by `/api/status` (no auth, `no-store`,
public severities only).

Coverage limits are operational facts, not caveats: gamma telemetry is the
European reporting networks republished by the German BfS service (the JRC's own
EURDEP value service was stale and partly unavailable when this was built — its
station catalogue timestamps were sixteen months behind — so the BfS mirror is
the live path and needs watching for lag drift) plus EPA RadNet's 140 US
monitors (one CSV per monitor per month, polled at most hourly; a new deploy
seeds the 48-reading baseline with `ingest_cbrn_radiation.js --networks radnet
--months 2 --force`); aircraft sampling is a fixed
roster of 16 public geographies, not a global picture; vocabulary counts come
from one post stream and one news index. A normal reading asserts nothing
outside the monitored area.

### Verifying the CBRN layer by hand

```sh
npm run cbrn:refresh                      # full pass; prints per-stage JSON
node scripts/detect_cbrn_radiation.js --db data/ews-cbrn.sqlite --events-db data/ews-main.sqlite --dry-run
node scripts/detect_cbrn_airspace.js  --db data/ews-cbrn.sqlite --events-db data/ews-main.sqlite --dry-run
node scripts/detect_cbrn_notices.js   --watch-db data/ews-watch.sqlite --events-db data/ews-main.sqlite --cbrn-db data/ews-cbrn.sqlite --dry-run
node scripts/detect_cbrn_lexical.js   --watch-db data/ews-watch.sqlite --cbrn-db data/ews-cbrn.sqlite --events-db data/ews-main.sqlite --dry-run
node scripts/fuse_cbrn_signals.js     --events-db data/ews-main.sqlite --cbrn-db data/ews-cbrn.sqlite --dry-run
```

Each detector prints what it would write and writes nothing under `--dry-run`.

### Recovery verification — 5 September 2026

The live audit found 82 open threads, 73 waiting, an exhausted twelve-attempt
cap, unapplied completed priorities, and no publication boundary for raw leads.
Fourteen temporary direct scenarios now pass, including the 234-record production
copy's migration, conservative budget settlement, expired legacy leases,
official-warning priority restoration, source recovery, and generation-safe
triage/publication. No permanent tests were added.

A real sixteen-report Scry batch and subsequent three-role investigation
completed in four calls for $0.0014278 of provider usage. A separate real-source
pair routed explicit television fiction to background and retained an unverified
current-event claim. The actual worker with a zero allowance made no inference
claims and preserved its 74 waiting leads.

Desktop and 390-pixel browser exercises verified private review, explicit
source-only publication without notes/drafts, and visible processing pause with
resumption time; neither layout overflowed. Two independent read-only reviewers
cleared the repaired lifecycle and inference/publication boundaries. GDELT's
upstream 429 remains a coverage gap with bounded recovery, not a healthy feed.

Production activated `ea11874` at 21:38 Pacific. Schema 2 passed integrity and
foreign-key checks; all 253 pre-migration evidence records were retained.
At 21:52 Pacific, the original backlog was empty: 82 leads had completed
screening and 73 investigations had completed since activation. The daily
ledger total was $0.0829 against $0.10. One newly arrived lead remained in
bounded retry; rejected output was not published, and the minute timer remained
active. The live desktop and mobile surfaces exposed no unreviewed threads.

### Implementation evidence — 5 September 2026

The release build and existing alert-pipeline smoke passed. Nine temporary
behavior scenarios exercised immutable reversion, duplicate clocks, multilingual
triage and replay fencing, plain social text and durable stream continuation,
multi-parent CAP cancellation and late originals, candidate correction
propagation, queue continuation beyond 120 threads, cited originals after
85 revisions, model validity/citations/partial usage, and disk restart/freshness.
The scenarios were throwaway execution proofs, not new permanent tests.

A real collection pass checked all 21 enabled definitions and stored 193
observations without a source failure. Real Scry inference on captured public
reporting completed exactly three calls, with specialist, skeptical, and
synthesis findings citing only supplied evidence. Role attribution belongs to
the orchestrator, not model-generated labels. Two independent reviews drove
the correction-graph, context-validity, replay, pagination, and source-boundary
repairs. Desktop and 390-pixel browser exercises verified layout, private
draft access, saved local review, citation anchors, and absence of persisted
operator credentials. Public/private API checks returned 200/401 as intended,
invalid cursors returned 400, and all watch responses used `no-store`.

Production activation completed at 17:08 Pacific. The web service, minute watch
timer, and existing two-minute aviation timer were active. All four databases
had integrity-checked backups under `data/backups/2026-09-06/`. The production
service identity and private environment completed a three-call inference
exercise on retained official advisories. By 17:22 Pacific, two genuine
post-enrollment source changes had independently produced completed three-call
investigations with resolvable citations. No synthetic incident or human review
was inserted into production.

The dependency audit also reported inherited `nanoid` 3.3.15, `postcss` 8.5.15,
and `qs` 6.15.2 advisories. These versions are unchanged from the pre-watch
deployment. No blanket dependency upgrade or unrelated operational remediation
was performed.

The corrected production transport reached GDELT in 10.9 seconds, within the
unchanged deadline, and received HTTP 429. At 17:30 Pacific, 20 enabled
definitions were healthy and GDELT remained explicitly degraded. No route,
credential, access-control bypass, or immediate retry was introduced; its normal
30-minute source cadence remains in force. Public source titles are marked as
quoted source material, not verified events or machine findings.

## Civilian reliance contract

**Status: not served.** The household plan and its guidance surface are
unrouted as of 11 September 2026 — the public site is one page of measurements
and alerts. The analysis below is retained because it still describes how the
plan's properties fail; the component source was removed on 20 September 2026
and lives in git history.

The resident product is a plan for receiving and acting on an official warning
while continuing ordinary city life. Its useful unit is a household decision,
not a dramatic signal, a queue item, or a predicted attack probability. Preparation,
warning delivery, protective action, and later official updates are different
jobs: a successful page load must not be mistaken for successful warning delivery.

The design was decomposed across civilian decisions, official message integrity,
and the actual delivery chain. Independent source/code investigations exposed
two consequential gaps: official messages were behind human publication, and
existing subscriptions delivered aviation anomalies rather than civil warnings.
The following taxonomy ties product properties to concrete ways they can fail.

| Property | Required behavior | Discriminating failure scenario |
|---|---|---|
| Role clarity | A resident can identify the primary warning routes, the stored plan, and this site's supplementary evidence without understanding operations | A sleeping resident believes an open website or aviation signup will wake their phone for a civil warning |
| Actionable preparation | Record phone settings checked by the user, complementary local enrollment, radio/power backup, and remaining practical work; do not manufacture a readiness score | Every form field is filled, but emergency alerts are disabled or the radio has no usable power |
| Shelter feasibility | Identify reachable places at home, work and elsewhere, with access hours, keys, mobility constraints and alternatives | The planned building is locked at night or the preferred route requires an unavailable lift |
| Household continuity | Record out-of-area contact arrangements and school/care plans before an alert; do not direct families to travel through a radiation emergency to reunite | The only person who knows the plan is absent, or a parent goes outside to collect a child already sheltered at school |
| Primary-source authority | Keep issuer, original area, exact source instructions, references and dates distinct from reporting or interpretation | A model summary or an operator's private note appears to be an official protective instruction |
| Geographic applicability | Label state filtering as coarse; retain unresolved areas and disclose missing jurisdictions rather than infer an address match | A traveller keeps their home-state selection, or an unmapped notice silently vanishes from a filtered view |
| Message lifecycle | Distinguish active, upcoming, expired, cancelled, superseded and unverified messages; only qualified actual/public corrections alter real-message state | A test cancellation suppresses a real notice, an old update wins, or an ended instruction remains current |
| Time and failure visibility | Separate source success, observation age and validity; age retained content even when refresh fails; silence is not a safety state | A recently rendered page contains yesterday's source data, or a sleeping tab resumes with expired instructions |
| Critical-path independence | Source-attributed official notices do not wait for model credit, investigation leases, or an awake operator | A real public CAP warning enters the private queue while the model budget is exhausted |
| Delivery diversity | Primary phone/local alerts and a non-internet backup are explicit; permission, enrollment and successful delivery are different facts | Internet loss defeats two apps sharing the same connection, or an enabled permission is mistaken for end-to-end delivery |
| Offline usefulness | A downloaded or printed plan contains the actual entries and immediate guidance, without scripts, external assets, account access or live-status claims | The network fails and the saved item is only a bookmark, a login page, or a stale green dashboard |
| Privacy and preservation | Household details remain browser-local; public sharing includes no entries; storage failures are visible and preserve recoverable data | A shared-device user sees another household's plan, a public link contains contacts, or a quota failure silently loses edits |
| Cognitive and physical access | Instructions remain readable, keyboard-accessible and non-color-dependent on a narrow screen and on paper | A resident with tremor, low vision or stress cannot find the next action without navigating operational metrics |
| Practice without deception | Practice is always visibly labelled, sends no warning, and records only a self-reported exercise | A drill looks like a real emergency, or completion of a walkthrough implies a device or shelter was verified |
| Community trust and maintenance | Share the blank planner; identify source/review/export dates and practical assumptions needing review; do not invent staffed monitoring | A forwarded plan leaks personal details, or an old shelter/access assumption is treated as a maintained community guarantee |
| Evidence proportionate to reliance | Release claims follow direct behavior, independent review and live verification; compilation alone proves neither timely delivery nor useful action | Correct code and attractive screens are used to claim unobserved locked-device delivery or survival outcomes |

The former resident surface was `/plan`, which is no longer routed.
Its entries are local to that browser, not an encrypted household account or a
community coordination service. The static export is a separate private copy;
deleting browser data does not erase copies already downloaded or printed.
The interface is English; linked official guidance provides additional resources.

`GET /api/watch/official` is a no-store, deterministic mirror of selected NWS
Actual/Public civil notices. Its only optional query is an uppercase US
state/territory code. The source checks active messages and bounded seven-day
history, including older active alerts. At most four pages/1000 records are
collected per pass. Validated pages survive another lane's failure or source
deadline, but run cancellation still prevents publication; incomplete coverage
remains explicit. A partial HTTP 429 response retains its Retry-After deadline,
including under forced collection.

Schema version 4 preserves immutable evidence and separates current active
membership from the last positive membership time. The public read considers
at most 2000 current heads, recently listed prior heads, and recent revisions,
in that priority order, and returns at most 200. Qualified current-head CAP
controls use an indexed full sender/identifier/sent tuple and causal control
time; test, private, mismatched, or obsolete revisions cannot control a real
notice. The one-time projection migration uses bounded 200-row keyset pages.
Counts and truncation describe those bounds, not a complete national emergency
inventory. Unmapped geography stays visible. Missing snapshot membership is
uncertainty, not cancellation; a source outage does not rewrite an issuer's
validity window. Browser timing follows server time plus monotonic elapsed
time. Resume, clock discontinuity, and failed refresh withhold confirmation
until a fresh matching snapshot arrives.

There is no background civil-warning delivery from this page, comprehensive
IPAWS subscription, verified shelter directory, or staffed household check-in.
Existing aviation subscriptions keep their original purpose. Adding a delivery
promise requires explicit geographic enrollment, correction/withdrawal handling,
observable endpoint failures, and evidence from the actual locked-device path;
it cannot be inferred from this official-message display.

Protective guidance is grounded in
[https://www.ready.gov/radiation](https://www.ready.gov/radiation),
[https://www.cdc.gov/radiation-emergencies/response/get-inside.html](https://www.cdc.gov/radiation-emergencies/response/get-inside.html),
and [https://www.cdc.gov/radiation-emergencies/response/stay-inside.html](https://www.cdc.gov/radiation-emergencies/response/stay-inside.html).
The distinction between automatic compatible-phone WEA and complementary local
enrollment follows [https://www.weather.gov/wrn/wea](https://www.weather.gov/wrn/wea).
These sources were read directly on 5 September 2026; neither a generic shelter
duration nor a message disappearing constitutes an automatic all-clear.

### Resident release verification — 6 September 2026

Disposable execution covered 18 public CAP lifecycle cases, coarse state
filtering, unresolved geography, expiry, staleness, partial history failure,
153 non-authoritative controls, a ten-day unchanged alert disappearing,
2500 obsolete heads, and schema 2→4 migration with original evidence preserved.
The actual collector CLI retained a validated notice after its source deadline
but published nothing after run interruption. Partial Retry-After admission
remained enforced even with `--force`.

Two independent background Chromium pages proved concurrent-save preservation,
clear-confirmation invalidation, the delayed-storage-event deletion guard, and
erasure of recovery data. Fast and slow device clocks retained correct notice
timing; failed refresh after resume withheld confirmation. HTTP exercises
confirmed query rejection, no-store output and the operator authentication
boundary. The actual 390px surface had no horizontal overflow. The generated PDF
placed protective action first and printed full entries; downloaded HTML opened
with networking disabled, without scripts or external assets, preserving input
literally. The production build passed.

Independent resident-reliance and official-integrity reviews closed their
findings before release. These checks do not establish locked-device delivery,
complete jurisdiction coverage, or survival outcomes. No permanent tests were
added.

Activated `a1b32cc` from `5288d25` on 6 September 2026 at 01:45 Pacific.
The watch timer and collector were paused around the cutover. A fresh watch-only
backup at
`data/backups/resident-release-2026-09-06T08-42-04-160Z/ews-watch.sqlite`
passed integrity checking. The live schema is 4; all 406 pre-cutover evidence
observations remained byte-identical by ID, with zero missing or changed.
The deployed database integrity check passed, and the web service and watch
timer were active afterward. The scheduled source refreshed again at 01:48.

The real NWS collection completed both bounded lanes without a failure or
truncation. Official coverage was current with zero selected notices, while
model investigations were budget-paused: official intake did not depend on
model credit. Zero notices is not an all-clear. Public browser requests to both
official selections, the watch endpoint, and all three aviation JSON endpoints
returned HTTP 200 with no-store. The live 390px planner rendered without overflow;
the watch visibly retained its incomplete-coverage and no-all-clear boundaries.

The separate local dashboard-bundle verifier rejected absent absolute
`VITE_*_DASHBOARD_URL` configuration and root-relative fallbacks. No dashboard
URL contract changed; the actual same-origin deployment paths were verified
above instead. The unchanged lockfile's dependency audit reported four high
advisories (`concurrently`, `shell-quote`, `nanoid`, `postcss`) and one moderate
(`qs`). No dependency upgrade or exploitability judgment was made in this
resident-product release.

## Assurance contract

This is a consequential public instrument, not a certified emergency-warning
system. Aircraft activity alone cannot establish that an attack is imminent or
that conditions are safe. No alert is not evidence of safety. Official emergency
instructions take precedence. Claims of "NASA-grade", certification, guaranteed
delivery, or a two-minute observation latency require evidence we do not yet have.

The standards below are engineering references, not a claim of conformance.
Apply their relevant controls to the existing code and release process; do not
add abstractions or paperwork that do not control an identified failure.

| Reference | Applicable obligation | Concrete evidence required here |
|---|---|---|
| [NASA NPR 7150.2D](https://nodis3.gsfc.nasa.gov/displayDir.cfm?t=NPR&c=7150&s=2D), §§3–5 | Requirements traceability, lifecycle planning, configuration control, peer review, defect management | Each changed requirement maps to source, an exercised scenario, a reviewed commit, and deployed revision; unresolved limits stay explicit |
| [NASA-STD-8739.8B](https://standards.nasa.gov/standard/NASA/NASA-STD-87398), §4 and Appendix A | Hazard analysis, software assurance, independent verification | Review missed alarms, false alarms, stale-as-calm output, partial cohorts, failed delivery, and recovery separately; an independent reviewer examines the release |
| IEEE 1012-2017, referenced by NASA-STD-8739.8B §2.2 | Verification and validation across normal, abnormal, and boundary conditions | Existing production-path replay plus direct ingestion, failure/recovery, and browser exercises; passing compilation is insufficient |
| [NIST SP 800-218 SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final) | Protect source, produce reviewed releases, manage dependencies and vulnerabilities | Locked installs, no unreviewed dependency upgrades, secret-free source and logs, small reversible commits |
| [OWASP ASVS 5.0](https://owasp.org/www-project-application-security-verification-standard/) | Input validation, resource limits, access control, safe error handling | Feedback uses the existing validated intake; bounded text/media/request time; failures remain visible; possession tokens never enter feedback context |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | Keyboard access, visible focus, understandable status, non-color-only meaning | Feedback opens/closes with keyboard and restores focus; narrow-screen rendering works; stale/unknown state is explicit text |
| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) | HTTP method, failure, retry, and cache semantics | No automatic retries of an uncertain feedback POST; no success on a failed response; dynamic measurements are not served as fresh through a cache |

### Hazard controls and release floor

| Hazard | Required control | Remaining limitation |
|---|---|---|
| Late warning | Measure source observation age separately from poll age; bound polling, processing, and browser refresh independently | A 30-minute archive cannot supply two-minute observations, regardless of timer frequency |
| Dead instrument appears calm | Unknown/stale source timestamps invalidate current-status reassurance; one fresh cohort must not mask an older selected cohort | A recent sample is not proof of source completeness or absence of an emergency |
| Feed change manufactures an anomaly | Preserve supplier, cohort, sampling-window, and counting-process provenance; warm/calibrate a new feed separately | A smaller live feed cannot be compared directly with the current global archive baseline |
| Repeated polling manufactures an alarm | Deduplicate by source sample, not poll time; advance sequential state only on a new observation | External delivery is not a distributed exactly-once transaction |
| Slow/hung refresh consumes the schedule | Single active writer, bounded subprocess/network work, explicit timeout failure, no queued tick backlog | A missed deadline is degraded service, not a successful refresh |
| Partial pipeline hides failure | Publish complete files atomically; retain last known data; report failed stages; independent delivery channels remain independent | A retained old snapshot must still age into stale state |
| Lost or duplicated feedback | Existing durable Scry intake, acknowledgment only after stored success, preserve draft on errors, no blind POST retry | A lost acknowledgment is an uncertain outcome; intake is not an emergency dispatch channel |
| Unsafe release or recovery | Build the locked revision; exercise affected behavior before activation; record previous revision; preserve databases; fast-forward the deployed checkout | Backups alone do not prove restoration or eliminate single-host/provider failures |

For each release, record the scenario and observed outcome below the relevant
change entry. At minimum, a cadence change exercises no-new-data, new-data,
duplicate sample, overlapping invocation, and failure/recovery paths. A feedback
change exercises validation, backend failure, draft retention, keyboard use,
and narrow screens without posting synthetic correspondence to the live queue.
Existing replay checks defend alarm sensitivity and specificity; cadence work
does not authorize retuning their thresholds.

The release reviewer must distinguish controls actually exercised from controls
established only by inspection. Formal safety classification, independent
organizational assurance, measured availability/error budgets, restore drills,
source diversity, and validated attack-warning performance remain open
assurance work; this checklist does not certify them.

## Signal semantics

- `emergencyLevel` 1–5 from concurrent-airborne deviation vs. a weekday×slot
  seasonal baseline (7-day/336-sample minimum warm-up, US-holiday calendar
  model, alarm threshold self-calibrated to the second-highest historical
  daily peak); level ≥ `EWS_ANOMALY_ALERT_LEVEL` (default 5) generates an
  alert event. Slot baselines are **median + scaled-MAD**, not mean/stdDev:
  each weekly slot group holds one sample per week, and mean/variance stats
  let the live exodus being scored (present in its own baseline group) drag
  the mean and explode the sigma — a 3× injection scored σ2.4 under
  mean/stdDev vs σ27.9 under median/MAD.
- Takeoff-rate anomaly (`takeoff-rate-seasonal-negbin`, 2026-09-19): the
  live-process window count is scored **as a count**. Expected rate = clipped
  mean of the (weekday/weekend × slot-of-day) group over
  `EWS_TAKEOFF_RATE_LOOKBACK_DAYS` (28); dispersion = Pearson chi-square pooled
  over every group in the lookback, floored at 1; score = **surprise** =
  −log10 P(X ≥ count) under that negative binomial. Thresholds are the alert
  budget turned into a probability — 12 / 4 / 1 public alerts a year =
  surprise ≥ 3.16 / 3.64 / 4.24 — and the public tiers also need the magnitude
  gate, count ≥ 3× expected. Surprise ≥ `EWS_TAKEOFF_RATE_SURPRISE` (2) is
  recorded as an operator-surface `watch` event. Every ready slot's surprise
  goes to `slot_scores`; once that record holds 1,460 slots it acts as a
  second guard that can only raise a threshold (strictly exceed the k-th
  largest, k = floor(budget × n / 17,520), lift capped at 2 decades so day one
  of a real event cannot mute day two). Backfill the record with
  `backtest_detector.js --write-scores --takeoff-days 120`. Why counts: the
  previous median/MAD z-score read "5 takeoffs vs 0.8 expected" as 4.2σ and
  produced 25 of the 28 public alerts raised between 14 July and 16 Sept;
  on the same record the negative-binomial tail is calibrated (nominal
  0.1 / 0.01 / 0.001 → observed 0.088 / 0.0088 / 0.0008) and raises none.
  **Both numerator and baseline count only
  `source='adsbx_heatmap'` events** — trace-backfilled events (`adsbx_history`,
  ~45× denser, written by repair with sub-slot timestamps) are a different
  counting process and are excluded, so a repair pass touching the current
  window cannot manufacture a false critical.
- `sustained_shift` (CUSUM): S ← max(0, S + σ-shift − k) per slot over the
  concurrent signal with k = `EWS_CUSUM_K` (1.5); crossing
  `EWS_CUSUM_THRESHOLD` (12) fires high, crossing `EWS_CUSUM_CRITICAL` (20)
  fires critical; re-arms after S falls below half the threshold. Catches
  slow exoduses that never spike the instantaneous gauge. Tuned 2026-08-28
  on 66 days of box data: fires high on exactly the two hottest real
  sustained days, never critical on history (peak S 16.1); a 3× exodus
  accumulates S≈13 in the first hour. State in `meta` key
  `cusum_state:<cohort>`. **First-year calendar gate:** inside a US-holiday
  window the calendar model has not yet learned (zero prior-year samples),
  CUSUM freezes — the year-one replay showed Thanksgiving/Christmas travel
  waves burning ~9 false criticals as genuine week-scale sustained shifts.
  The instantaneous and takeoff channels stay armed through the window,
  and the gate self-expires once a prior year's holiday samples teach the
  calendar ratio.
- L0 data-quality gate: the live ingester records the global feed total per
  slot in `ingest_slots`; if the current slot carries under
  `EWS_DATA_QUALITY_MIN_RATIO` (0.6) × the 14-day same-slot median, all
  statistical events are suppressed and a `data_quality` event is emitted
  instead — an infrastructure failure must not read as an exodus.
- Detection is calm-by-default: no baseline → no alert (fail-quiet, not
  fail-noisy); degraded feed → suppressed + surfaced, never scored.
- `npm run backtest -- --db data/ews-main.sqlite --cohort global_business_jet
  --inject-exodus` replays history through the production code paths:
  frequency tables for every layer plus the 3×-exodus injection acceptance
  test (must reach HIGH within 60 minutes and CRITICAL within 120, by
  either channel). Add `--assert` to enforce the instrument bounds below
  (non-zero exit on violation) — this is what the nightly selftest timer
  runs.

## Instrument bounds

Every alarm limit has a written basis and a place where it is enforced —
continuously, not once at commissioning. Sensitivity bounds (does a real
emergency fire?) and specificity bounds (does quiet data stay quiet?) are
asserted together so a change that buys one by selling the other fails
loudly.

| Bound | Value | Basis | Enforced by |
|---|---|---|---|
| Data age (any row) | ≤ 75 min | 30-min source cadence; retained as the source-outage bound, not a polling target | `status.js` → watchdog (2-min cadence) |
| Live-ingestion age | ≤ 75 min | same cadence; distinct from row age because repair heals rows without the live instrument running | `status.js` → watchdog |
| Live slots, trailing 24 h | ≥ 42/48 | live path should hit every slot; 6 misses/day means it is skipping | `status.js` → watchdog |
| Slot completeness, 30 d | ≥ 98 % | every expected slot is live, backfilled, or accounted missing | `status.js` → watchdog |
| 3× exodus → HIGH | ≤ 60 min | the reason the system exists; replayed nightly by injection | `backtest --assert` (selftest timer, 03:40 UTC) |
| 3× exodus → CRITICAL | ≤ 120 min | one 3× slot reads ~9–10σ while the self-calibrated alarm line sits at ~11σ (2nd-hottest real day — Dec 27 holiday wave hit 11.1σ with no apocalypse); sustain is what separates an exodus from a holiday wave, and CUSUM accumulates it past critical inside two hours (recalibrated 2026-08-30 on the full 365-day history) | `backtest --assert` |
| Takeoff false criticals | 0 in replay | critical is a paging severity; history contains no exodus | `backtest --assert` |
| Takeoff public alerts | ≤ 12/yr (+2 slack per replay) | the stated alert budget; counted at elevated and above, the tiers a subscriber receives | `backtest --assert` |
| Takeoff score calibration | 1-in-100 scores in ≤ 2 % of slots | the thresholds are tail probabilities; if the tail stops being honest the thresholds stop meaning what the page says | `backtest --assert` |
| CUSUM crossings | ≤ 1.5/30 d (critical ≤ 0.5/30 d) | sustained-shift pages must stay rare on real history | `backtest --assert` |
| Concurrent level-5 days | ≤ 1/30 d (level ≥ 4 ≤ 2/30 d) | threshold self-calibrates to 2nd-highest daily peak ⇒ ~1 alarm/yr as history deepens | `backtest --assert` |
| Detector warm | ≥ 336 scoreable slots | below a week of live baseline the takeoff channel cannot score | `backtest --assert` |

**Latency is a chain, not a timer setting.** Source observation → archive
publication (30-minute archive windows plus upstream release lag) → next poll
(target ≤2 min) → ingestion/scoring/delivery (measured per run) → subscriber or
browser refresh (browser target ≤1 min). An unavailable upstream archive has no
bounded release time; this is not a guaranteed two-minute warning system.
Sequential alarm bounds remain measured in source samples, not poll attempts.
The 75-minute source-age bound plus a healthy two-minute watchdog gives a
nominal ≤77-minute stale-source detection bound, excluding notification delivery.
Poll failures have a separate shorter bound in `status.js`.

### Live-source prerequisite

Genuine two-minute observations require an authorized **global** live snapshot,
including the non-ICAO namespace and a same-snapshot coverage denominator.
Changing suppliers or sampling semantics requires a separate provenance lane,
baseline warm-up, and calibration; never splice live counts into archive history.
No new feed subscription or access request was authorized by the cadence change.

| Candidate | Documented capability | Gate or incompatibility |
|---|---|---|
| [ADSBx live](https://www.adsbexchange.com/community/developer-hub/) / [API schema](https://gateway.adsbexchange.com/api/aircraft/v2/docs/openapi.json) | Global `/all` endpoint, readsb/ADSBx fields | Paid key and [publication/use permission](https://www.adsbexchange.com/acceptable-use-policy/); two-minute polling is 21,600 calls per 30 days |
| [adsb.fi open data](https://github.com/adsbfi/opendata/blob/main/README.md) | Global snapshot refreshed twice per minute | Feeder-IP authorization and personal/non-commercial terms; different coverage |
| [ADSB.lol full feed](https://www.adsb.lol/docs/feeders-only/re-api/) | Whole-network unfiltered data | Feeder-IP authorization; [public API](https://api.adsb.lol/docs) has no documented global `/all` and dynamic limits |
| [OpenSky REST](https://openskynetwork.github.io/opensky-api/rest.html) | Global state vectors | Anonymous 400 credits/day at 4/global query permits only 100/day, not 720; ICAO24 model is not the non-ICAO counting process; [operational-use agreement](https://opensky-network.org/about/terms-of-use) required |
| [ADSBHub](https://www.adsbhub.org/howtogetdata.php) | Contributing-station global SBS feed | Station/IP authorization; non-ICAO compatibility unestablished |

### Public feedback

The persistent Feedback form on the React pages uses Scry's existing anonymous
intake directly: `https://api.scry.io/v1/feedback` and `/v1/feedback/audio`,
tagged `channel=warning-watch`. It shares the existing operator queue rather
than creating another unmonitored store. Direct browser submission preserves
per-client abuse limits; a reverse proxy would collapse visitors onto one quota.
Text, voice, and images are bounded, and only a stored-success response clears
the draft. Uncertain delivery keeps the draft and warns that retry may duplicate.
Page context excludes query strings, fragments, and referrers. This channel is
not monitored in real time and is not an emergency dispatch service.

### Non-ICAO coverage and calibration correction

The 2026-09-05 correction records the unfiltered global telemetry count from
the same newest populated slice used by the non-ICAO live snapshot. It counts
signed coordinates and repeated records exactly as the canonical parser does.
A populated ICAO-only slice is valid zero non-ICAO activity; an empty archive
does not establish coverage or a live execution. Historical repair preserves
known totals, live provenance, and execution marks. Historical NULL totals
can be recovered from the business database only at identical observation
timestamps with genuine `adsbx_heatmap` live provenance in both databases.

Non-ICAO now uses mean-relative residual calibration, re-dimensionalized at
each seasonal prediction, with a `sqrt(max(expected, 1))` count-noise floor.
This removes the busy-stratum absolute floor that suppressed quiet strata.
Business and military retain their absolute-count profiles; their historical
scores and thresholds matched the deployed control exactly. Single-cohort
dashboards consume server scores. Combined-cohort aggregate semantics and
all alarm bounds remain unchanged.

Exact candidate replay through the 04:29:50 Pacific observation passed all
18 business/military bounds. Non-ICAO reached HIGH and CRITICAL in 30 minutes
and passed its noise bounds; its replay had only 2 scoreable takeoff slots
against the unchanged 336-slot assurance minimum. Current takeoff scoring
can be ready before that many historical scoreable outcomes have accumulated.
The two configured nightly cohorts are unchanged.

A separate frozen-model experiment trained through August 29 at 04:00 Pacific
and evaluated the following seven days: 333 overlapping four-slot windows,
zero initial CUSUM, and the production holiday freeze. No injected or holdout
counts entered the training baseline or calibration. Each cell below counts
HIGH within 60 minutes / CRITICAL within 120 minutes, before → after:

| Expected mean | Windows | 3× observed count | 3× expected count |
|---|---:|---|---|
| 3–10 | 28 | 0/0 → 13/15 | 0/0 → 9/0 |
| 10–30 | 33 | 0/0 → 17/18 | 0/0 → 23/20 |
| 30–100 | 39 | 18/8 → 30/31 | 21/18 → 36/36 |
| ≥100 | 233 | 215/221 → 217/219 | 229/232 → 232/231 |

These are descriptive, overlapping windows, not independent trials or a
universal sensitivity guarantee. Quiet strata still have material blind spots,
including 0/28 critical detections for three times the expected count at mean
3–10. The existing nightly injection refits altered history and its moving
endpoint can change the verdict: unchanged business scoring took 90 minutes
to HIGH at the 03:59:50 observation, then 60 minutes at 04:29:50. Neither a
single passing window nor this calibration correction closes that assurance gap.

Direct execution covered five binary selection cases against the canonical
parser, both history repair paths, zero-cohort clearing, empty and backward
observations, zero-MAD live/archive parity, and healthy/degraded/unknown/stale
coverage decisions. Existing ingestion and alert-pipeline smokes passed.
Independent ingestion and calibration reviewers found no blocker.
Legacy non-ICAO unsigned latitude filtering still omits southern-hemisphere
cohort rows; changing that definition requires historical reconstruction and
recalibration, not a live-only count expansion. The global denominator does
include those coordinates. Historical peak counts and timestamps are unchanged.

Production activation completed at 05:03 Pacific on 2026-09-05. The genuine
05:02 live run had already recorded the new 04:59:50 observation with 7,160
global records and six non-ICAO snapshot rows, before historical restoration.
An integrity-checked backup preceded the recovery of 338 exact-source NULL
totals; no live slots remained without a global total. Seven same-time
references still leave L0 coverage correctly `unknown` until the eighth exists.
All public snapshots exposed the intended profiles with `Cache-Control: no-store`.
The actual nightly unit passed in five seconds at 05:06 Pacific, two-minute
polling remained active, and operational status reported healthy. That
operational verdict does not close the statistical limitations above.

### Frozen count-likelihood candidate rejected

The follow-on 2026-09-05 experiment kept the August 29 training cutoff and
seven-day holdout fixed. Training contained 2,537 observed half-hours:
52.85 observed days, not the 66.21 elapsed days across gaps. Median/MAD
plug-in negative-binomial likelihood ratios were evaluated as heuristic
scores, not calibrated probabilities; stock-count serial dependence remained.

At HIGH/CRITICAL cutoffs 12/20, the candidate produced three training
crossings, including one critical: 1.703/0.568 per 30 observed days, above
the literal 1.5/0.5 budgets. The frozen sigma control produced two/one.
For the 28 quiet holdout windows with expected mean 3–10, the candidate
improved three-times-expected HIGH/CRITICAL successes from 9/0 to 17/19,
but three-times-observed successes remained 13/15. Holdout noise was zero.

Rejecting every training critical requires a cutoff above the observed
39.122 excursion. Four contributions capped at eight can accumulate at most
32 from zero, so this candidate cannot then add two-hour critical detection.
Kimi-k3 independently recommended keeping production unchanged. This rejects
the tested clipped-likelihood design, not every possible detector.

The existing assurance checks round permitted event counts upward; their
passing verdict is not proof that literal rates hold in a short sample.
No threshold, production scoring law, or permanent test was changed by
this experiment, and the holdout was not recycled into a new calibration.

### Detector assurance status

The business-jet nightly replay ending 2026-09-04 18:45 Pacific failed its
0.2/day takeoff-noise bound with seven fires. The defect was a one-slot phase
error, not an insufficiently permissive threshold: history was grouped by
observation/window end, while the target selected its window-start group.
The 2026-09-05 correction uses the end clock for both. Five of the seven original
fires disappear when compared with the correct same-time history; genuine
same-time outliers remain. Count, z-score, severity, variance floors, seasonal
group minimums, warm-up requirements, and acceptance bounds are unchanged.

Live detection and replay now share a final-slice `ingest_slots` loader.
Concurrent metrics retain their independent calibrated peak timestamps/counts.
History occupies `(windowStart - lookback, windowStart]`, disjoint from the
current transition window `(windowStart, windowEnd]`; replay includes the full
earliest lookback. Real zero-event slots survive missing or differently timed
concurrent rows, and trace-backfill events remain excluded.

Read-only candidate execution against the full production histories passed all
nine existing bounds for each of business and military: five takeoff fires per
30 calendar days, zero takeoff criticals, and 768 scoreable takeoff slots each.
The injected HIGH/CRITICAL times were 30/120 minutes for business and 30/30 for
military. These noise denominators remain calendar days, not exposure-adjusted
days. The non-ICAO replay recovered 336 final-slice slots instead of zero exact
metric joins, but still had no warmed takeoff scoring windows and failed its
3× concurrent-injection HIGH/CRITICAL checks. It is not covered by the existing
two-cohort nightly unit; its warning sensitivity is not established.

L0 quality is also shared with replay. Missing global totals or fewer than eight
same-time references report `unknown`, never a coerced zero or affirmative
`ok`. The existing policy still scores unknown coverage; only known degraded or
non-live takeoff slots are suppressed. All replayed slots in this measurement
had unknown coverage. Non-ICAO has no recorded global denominator. Historical
`seeded_live_day` rows remain explicitly inferred provenance, not per-slot
execution proof; this release does not rewrite them or change that policy.
The audited 335 non-ICAO live marks all matched completed live runs, with all
334 predecessor intervals exactly 1,800 seconds. Post-gap transition timing
and individual-airframe observation opportunity remain separate limitations.

Activation at 03:42 Pacific on 2026-09-05 ran the actual nightly systemd unit:
both configured cohorts passed, the service finished successfully in five
seconds, and operational status became healthy with two-minute polling active.
The deployed detector exposed 672/672/335 eligible business/military/non-ICAO
baseline samples against the unchanged 336 minimum. Non-ICAO therefore remained
correctly warming rather than permanently losing its history to the clock join.

Isolated direct execution covered shifted peak timestamps, 1,316 genuine zero
slots, history-source exclusion, end-clock seasonal selection across midnight,
range endpoints, exclusion of the current target from its own baseline,
unknown/missing provenance, and the unchanged 0.6 feed-degradation boundary.
Live and replay quality decisions matched. The existing alert-pipeline smoke
passed. Two independent reviewers found no blocker in the configured
30-minute path; nondefault wider-window replay parity remains unestablished.

### Cadence release verification

Direct execution on an isolated copy of real data: one new archive ingested and
scored for all three cohorts in 4.04 seconds; an unchanged poll completed in
1.41 seconds without changing dashboard mtimes, takeoff counts, CUSUM state, or
observation clocks. Poll success advanced separately. A forced network refusal
exited nonzero without treating cached data as a successful poll; recovery cleared
the failure only after a successful pass. A competing invocation skipped while
the OS lock was held. Default and latest-only decoding returned identical latest
telemetry for a real 180-slice archive (5.82 seconds versus 0.042 seconds locally).
These are local measurements, not production latency guarantees.

The first production pass exposed a scale-dependent detector timeout: SQLite
selected the covering `(cohort, hex, observed_at, source)` uniqueness index and
scanned the cohort for every baseline slot. Live detection and replay now require
the existing `(cohort, observed_at)` index for that lookup, without changing
counting or calibration. Against 2,337,426 production takeoffs, the bounded query
returned 1,362 slots in 0.008 seconds and exactly matched an independent grouped
count. The actual Node baseline function took 12.4/6.1/1.4 milliseconds across
business/military/non-ICAO databases. At that checkpoint, the last still had
zero eligible samples because of the subsequently corrected clock join. The deadline
remains 90 seconds per child; it was not raised to conceal the query failure.

Production activation at 02:47 Pacific on 2026-09-05 completed a new-sample pass
in 6.58 seconds. The scheduled 02:48 unchanged poll completed in 0.72 seconds,
kept the observation clock unchanged, and scheduled the next poll for 02:50.
All three public dashboards agreed on the 02:29:50 observation, returned
`Cache-Control: no-store`, and exposed no ingestion error. The public Feedback
dialog opened and closed normally. Operational status reported only the existing
nightly selftest failure; no failure state or detector threshold was suppressed.

The locked frontend build and existing ingestion/alert-pipeline checks passed.
Browser interception exercised stored-success, rejection, malformed success,
duplicate submission, draft retention, image payloads, private-context exclusion,
keyboard focus, and a 390-pixel viewport without posting to the live feedback
queue. Browser scenarios also exercised stale/future timestamps, unready
baselines, mixed source slots, missing cohorts, and independent cohort recovery.
The reference standards above remain a control map, not a certification claim.

## Subscription channels

| Channel | Status | Needs |
|---|---|---|
| RSS | **live on the box** | nothing |
| Web dashboard | **live publicly at <https://warning.watch>** (Cloudflare tunnel; box keeps zero open inbound ports) | nothing |
| **ntfy public push** | **live, self-hosted with write auth** — subscribe to `https://ntfy.warning.watch/warning-watch-alerts` in the ntfy app. Anonymous read, writes require the publisher token (`EWS_NTFY_TOKEN`), so the old ntfy.sh public-write spoof vector is closed. Publishes elevated+ only (`scripts/publish_ntfy_alert.js`) | nothing |
| **ntfy ops watchdog** | **live, self-hosted** — subscribe to `https://ntfy.warning.watch/warning-watch-ops`; unhealthy verdicts and recoveries only | nothing |
| Owner push (xmsg → iMessage/email/desktop by severity) | retired with the laptop deployment (xmsg is Mac-only; `notify_local_push.js` silently no-ops on the box) | a box-reachable owner channel, if ever wanted |
| Telegram channel | token wired (@XyraClawdBot, reused from xyra_claw — sends don't conflict with its polling) | one 45-second phone step: create channel, add bot as admin, set `TELEGRAM_CHANNEL` in `.env` |
| Email (Postmark) | **live since 20 September 2026** (Postmark server `warning-watch`, sender domain `warning.watch` with DKIM and Return-Path verified, From `alerts@warning.watch`; sign-up, delivery and confirm exercised end to end), **double opt-in enforced** (signup sends a confirm link; only confirmed addresses are ever alerted; without `POSTMARK_SERVER_TOKEN` the sign-up route refuses the channel and the page does not offer it) | nothing |
| SMS (Telnyx) | code ready, **double opt-in enforced** (same as email; without `TELNYX_API_KEY` and `TELNYX_NUMBER` the sign-up route refuses the channel and the page does not offer it) | a Telnyx account, number and US carrier registration |
| Browser push (VAPID) | keys generated in `.env` | production deploy (below) |

## Activating email/SMS delivery

Everything generable is already configured on the box (VAPID keypair,
`INTERNAL_ALERT_TOKEN`, `NOTIFICATION_HASH_SECRET`,
`NOTIFICATION_ENCRYPTION_KEY`, `EWS_PUBLIC_URL=https://warning.watch`).
The irreducible credentials — add to `/etc/warning-watch.env` when the
provider accounts exist, then `systemctl restart warning-watch.service`:

1. `POSTMARK_SERVER_TOKEN`, `POSTMARK_FROM_EMAIL` (email; a Postmark server
   named `warning-watch` with the `warning.watch` sender domain verified)
2. `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_NUMBER` (SMS — deferred per
   ROADMAP §3; A2P compliance is the cost, not the vendor)

On activation, run `sendPendingConfirmations` for subscribers who registered
while delivery was dark, so their double-opt-in confirmations actually go out.

The refresh loop bridges alert events to an external webhook only when
`EWS_ALERT_EVENTS_WEBHOOK_URL` is **explicitly** set; it no-ops otherwise
(`missing_EWS_ALERT_EVENTS_WEBHOOK_URL`). It is never derived from
`APP_BASE_URL`/`EWS_PUBLIC_URL` — display URLs once pointed the bridge at
the upstream reference site.

## Codebase map (for cold-start agents)

- **`server/` + `scripts/` is the implementation** — the Express server,
  ingestion, detection, and all channel publishers. This is what runs.
- The former `functions/` + `workers/` Cloudflare Pages/D1 parallel
  implementation was **retired 2026-08-28** per ROADMAP §4 (recoverable from
  git history if ever needed). There is exactly one implementation now.
- `scripts/refresh_all_snapshots.js` is the pipeline entrypoint and the
  authoritative ordering of stages.
- `detect_alert_events.js` writes `alert_events` rows (UNIQUE event_key,
  idempotent). `server/publication.js` is the one answer to "is this event
  public" and the status clause every upsert uses: a rise to a higher public
  severity puts the row back to `pending`, so subscribers hear the escalation.
  `publications(event_id, rail, severity)` is the append-only firing record:
  subscriber dispatch and the public ntfy rail write it, ntfy's work is the
  public events with no row at their current severity plus retracted events it
  carried with no `retracted` row (a correction). A failed send writes no row,
  so the event retries. The operator push rail still keeps
  `local_push_last_alert_id` in `meta`.
- Severity ladder: watch < elevated < high < critical (see
  `severityForLevel` / `takeoffSeverity` in detect_alert_events.js).
- Python does ingestion/backfill (`update_latest_heatmap.py`,
  `backfill_history.py`, `track_non_icao_hex.py`); Node does everything else.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npm run status` → history stale | box outage or upstream feed break | `systemctl start warning-watch-repair.service` (or wait ≤6 h for the timer); if refresh itself is failing, `journalctl -u warning-watch-refresh` |
| heatmap downloads return 403 | ADSBx CDN rejects requests without a globe `Referer` (enforced ~2026-07/08) | all fetch sites send `scripts/adsbx_http.py` `GLOBE_HEADERS`; if 403 returns with those headers, the fronting changed again — re-probe with browser headers |
| `import_global_cohort` JSON errors | upstream basic-ac-db ships occasional malformed JSONL lines | tolerated (skipped + counted) up to 0.5% of lines; above that the feed itself changed — inspect a fresh download |
| refresh exits 1 with `failedStages` | one alert channel or feed export failed | other stages already ran; the failed channel's cursor holds and retries next pass — fix the named stage |
| SQLITE_BUSY crashes | long writer + missing busy_timeout on a new DB open | every `new Database()` must be followed by `pragma('busy_timeout = 30000')` |
| refresh exits 1 on `export_event_signals_feed` | snapshot vs DB timestamp skew > 35 min | genuine staleness — check ingestion; the 35-min slot tolerance is intentional (untracked cohort rounds `sampled_at`) |
| backfill locks everything | running an unpatched/old backfill | range DELETEs must commit before the download phase (fixed 2026-07-03); never run with default `--days 365` |
| ntfy topic spammed | ntfy.sh topics are public-write | self-host ntfy with write auth; rotate topic |

## Known operational notes

- ADS-B ingest is the free ADSBx globe-history heatmap: 30-min slots, no key,
  but requests need the browser headers in `scripts/adsbx_http.py`.
- `scripts/backfill_history.py` defaults to `--days 365`; always pass
  `--start-date/--end-date` for gap repair.
- All Node DB opens set `busy_timeout = 30000` (2026-07-03 fix) so the server
  and pipeline survive long writer transactions (backfills).
- History gaps stall the takeoff-rate model (needs 336 samples / 7 days); the
  concurrent-anomaly model likewise needs 7 days of continuous samples.
