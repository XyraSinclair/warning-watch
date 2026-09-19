'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { nearTestSiteCandidate } = require('./detonation-rule');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 500;
const SOURCE_TIMEOUT_MS = 25000;
let sourceDispatcher;
const USER_AGENT = 'Warning.watch/1.0 (https://warning.watch; public civilian warning research)';
const THEATERS = [
  ['US/NATO–Russia', /russi|ukrain|nato|moscow|kremlin|росси|украин/iu],
  ['US–China', /china|chinese|taiwan|beijing|中国|中國|台湾|臺灣/iu],
  ['India–Pakistan', /india|pakistan|kashmir|भारत|पाकिस्तान/iu],
  ['Korean Peninsula', /korea|pyongyang|dprk|한국|북한|조선/iu],
  ['Israel/regional escalation', /israel|iran|iraq|lebanon|jordan|gulf|gaza|syria|yemen|ישראל|איראן|إيران|اسرائيل/iu],
];
const POST_RELEVANCE = /nuclear (?:war|weapon|threat|attack|strike|test|detonation|explosion)|atomic bomb|radiation (?:leak|emergency)|radioactive (?:plume|release)|radiological (?:hazard|emergency)|missile (?:launch|attack|warning)|embassy.{0,40}evacuat|shelter.in.place|ядерн|核武|核战|核戰|核攻|核実験|핵무기|핵실험|핵공격|גרעיני|نووي|परमाणु/iu;
// CBRN event vocabulary. POST_RELEVANCE selects nuclear-strategy reporting; this
// selects a release in progress, which is what the CBRN vocabulary instrument
// counts. Deliberately excludes bare "evacuation" and "shelter in place": those
// are ordinary and would swamp both the incident queue and the burst baseline.
const CBRN_EVENT_RELEVANCE = /radiation (?:leak|level|spike|alarm|cloud)|radioactive (?:cloud|plume|release|contamination)|chemical (?:leak|cloud|release|spill|attack)|toxic (?:cloud|gas|release)|gas cloud|chlorine (?:leak|cloud|gas)|iodine (?:tablet|pill)|geiger counter|cesium-137|iodine-131|polonium|sarin|novichok|anthrax|smallpox|радиац|радіац|химическ\w* (?:оруж|атак)|токсичн|放射能|放射性|有毒气体|방사능|화학 물질|تسرب إشعاعي|تسرب كيميائي|गैस रिसाव/iu;
const CIVIL_EVENTS = ['Civil Emergency Message', 'Civil Danger Warning', 'Evacuation Immediate', 'Hazardous Materials Warning', 'Nuclear Power Plant Warning', 'Radiological Hazard Warning', 'Shelter In Place Warning', 'Tsunami Warning'];

function definition(id, name, family, mechanism, dependenceGroup, url, pollSeconds, staleSeconds, notes, extra = {}) {
  return { id, name, family, mechanism, dependenceGroup, url, enabled: true, accessStatus: 'public', pollSeconds, staleSeconds, sampleStaleSeconds: null, notes, ...extra };
}
function candidate(id, name, family, mechanism, dependenceGroup, url, notes, accessStatus = 'candidate') {
  return definition(id, name, family, mechanism, dependenceGroup, url, 3600, 86400, notes, { enabled: false, accessStatus });
}

const SOURCE_DEFINITIONS = [
  ...[
    ['business', 'Business jet cohort', 'dashboard.json'],
    ['military', 'Military aircraft cohort', 'military-dashboard.json'],
    ['untracked', 'Untracked aircraft cohort', 'untracked-dashboard.json'],
  ].map(([id, name, file]) => definition(`aviation-${id}`, name, 'aircraft', 'aggregate_aircraft', 'adsb-exchange-heatmap', 'https://warning.watch/aviation', 300, 5400,
    'R01: Existing half-hour aggregate publication only. Preserves existing classification; no identities, positions, paths, passenger or mission inference.', { adapter: 'aviation', file, accessStatus: 'existing_local', sampleStaleSeconds: 4500 })),
  ...[
    ['russia', 'US/NATO–Russia'], ['ukraine', 'US/NATO–Russia'],
    ['china', 'US–China'], ['taiwan', 'US–China'],
    ['india', 'India–Pakistan'], ['pakistan', 'India–Pakistan'],
    ['north-korea', 'Korean Peninsula'], ['south-korea', 'Korean Peninsula'],
    ['israel', 'Israel/regional escalation'], ['iran', 'Israel/regional escalation'],
  ].map(([country, region]) => definition(`govuk-${country}`, `GOV.UK travel advice: ${country.replaceAll('-', ' ')}`, 'administrative_acts', 'government_advisory', 'uk-fcdo-travel-advice', `https://www.gov.uk/api/content/foreign-travel-advice/${country}`, 1800, 7200,
    'R06: Public country content API; publication/change time is not internal decision or hazard-onset time. UK advice covers five theater lenses, not all national-language authorities.', { adapter: 'govuk', region })),
  definition('easa-czib', 'EASA conflict-zone bulletins', 'hazard_declarations', 'aviation_notice', 'easa-czib', 'https://www.easa.europa.eu/en/domains/air-operations/czibs/feed.xml', 1800, 7200,
    'R02: RSS listings, including historical/revised bulletins. Feed presence does not establish current validity; effective dates and cancellation may require the original bulletin.', { adapter: 'easa' }),
  definition('faa-status', 'FAA national airspace status', 'civil_transport', 'civil_aviation_status', 'faa-nas', 'https://nasstatus.faa.gov/api/airport-status-information', 300, 1800,
    'R03: Public XML current civil airport disruption snapshot. Disappearance means no longer listed, not a verified cancellation; partial local times remain verbatim, never assigned a year.', { adapter: 'faa' }),
  definition('nws-civil-alerts', 'NWS public civil emergency alerts', 'warning_emissions', 'official_public_alert', 'nws-cap', 'https://api.weather.gov/alerts', 120, 900,
    'R13: Selected civil emergency/radiological/evacuation/shelter/tsunami CAP events. Active alerts plus seven-day amendments/cancellations, at most four pages and 1000 records. Ordinary weather is excluded; not comprehensive IPAWS or a nuclear-intent signal.', { adapter: 'nws' }),
  definition('usgs-significant', 'USGS significant seismic events', 'radiation_geophysics', 'seismic_catalog', 'usgs-earthquake-catalog', 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson', 300, 1800,
    'R15: Significant past-week catalog; agency classification and revisions only. A seismic event is not nuclear confirmation; absence cannot exclude an airburst.', { adapter: 'usgs' }),
  definition('usgs-relevant', 'USGS relevant daily seismic events', 'radiation_geophysics', 'seismic_catalog', 'usgs-earthquake-catalog', 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson', 300, 1800,
    'R15: Past-day events filtered to magnitude >=4.5, agency-classified non-earthquakes, or magnitude >=3.5 within a known nuclear test site geofence. Same catalog as significant feed, not independent evidence; small earthquakes are not an exhaustive explosion screen.', { adapter: 'usgs', filterRelevant: true }),
  definition('noaa-kp', 'NOAA planetary geomagnetic index', 'confound_health', 'space_weather_measurement', 'noaa-swpc', 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', 900, 21600,
    'R16: Three-hour Kp measurement bins and station counts, not an EMP detector. Source time_tag is UTC; publication time is not supplied.', { adapter: 'noaa', sampleStaleSeconds: 28800 }),
  definition('gdelt-reporting', 'GDELT nuclear and escalation reporting', 'public_reporting', 'news_index', 'gdelt-syndicated-reporting', 'https://api.gdeltproject.org/api/v2/doc/doc', 1800, 7200,
    'R08: DOC article list, bounded newest 100 results over 24 hours; titles and originating publisher URLs, not manifest timestamps. English query over translated indexing; syndicated reporting is dependent, incomplete, and unverified. Seen time is index time, not publication.', { adapter: 'gdelt' }),
  definition('bluesky-posts', 'Bluesky public post discovery', 'public_reporting', 'public_social_posts', 'bluesky-atproto-public-posts', 'https://bsky.network/docs/jetstream/', 60, 600,
    'R09: Public unauthenticated Jetstream v2, sampled successfully. First enrollment joins the live tail without a cursor; no pre-enrollment coverage. Subsequent bounded sequential replay uses the exact durable inclusive cursor. Multilingual lexical selection, not exhaustive social search. Corrections retained for latest 200 matched posts; backlog/eviction gaps explicit.', { adapter: 'bluesky', sampleStaleSeconds: 600 }),
  candidate('bluesky-search', 'Bluesky appview search', 'public_reporting', 'public_social_search', 'bluesky-atproto-public-posts', 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts',
    'R09 alternate: public and api.bsky.app search endpoints returned HTTP 403 in access sampling. Search unavailable from sampled route; no credential requirement inferred from this refusal. Jetstream is the separate documented public route.', 'access_gated'),
  candidate('iho-navareas', 'IHO NAVAREA source directory', 'hazard_declarations', 'maritime_notices', 'national-navarea-coordinators', 'https://iho.int/navigation-warnings-on-the-web', 'R04: Directory, not a feed. Enroll each of 21 coordinators and audit update/cancellation coverage; may overlap NGA and national warnings.'),
  candidate('aishub', 'AISHub civil maritime aggregates', 'civil_transport', 'aggregate_maritime', 'aishub-ais-receivers', 'https://www.aishub.net/api', 'R05: Membership/username and verified entitlement required; provider ceiling one request/minute. AIS coverage incomplete. No individual vessel tracking adapter.', 'needs_access'),
  candidate('ted', 'TED public procurement', 'administrative_acts', 'public_procurement', 'eu-ted-notices', 'https://docs.ted.europa.eu/api/latest/index.html', 'R07: Anonymous published-notice search documented; needs scoped procurement taxonomy and bounded notice/revision enrollment. Publication is not private decision time.'),
  candidate('x-public-posts', 'X public-post discovery', 'public_reporting', 'public_social_posts', 'x-public-posts', 'https://docs.x.com/x-api/introduction', 'R10: Requires audited developer entitlement and usage terms, or explicitly vetted Scry X access. Neither credentials nor authorization assumed; copies of news are not independent witnesses.', 'needs_access'),
  candidate('mastodon', 'Mastodon public communities', 'public_reporting', 'public_social_posts', 'mastodon-instance-federation', 'https://docs.joinmastodon.org/methods/streaming/', 'R11: Current public streaming docs require a user token; enroll specific instances and their federation/deletion coverage, not a global feed.', 'needs_access'),
  candidate('reliefweb', 'ReliefWeb humanitarian reporting', 'public_reporting', 'humanitarian_index', 'reliefweb-originating-publishers', 'https://apidoc.reliefweb.int/', 'R12: Pre-approved appname required since November 2025; quota and original publisher attribution must be enrolled. No invented appname.', 'needs_access'),
  candidate('fema-ipaws', 'FEMA IPAWS warning coverage', 'warning_emissions', 'official_public_alert', 'ipaws-originating-alert-authorities', 'https://www.fema.gov/emergency-managers/practitioners/integrated-public-alert-warning-system', 'R14: Application-feed entitlement and jurisdiction contract unresolved. NWS carries some overlapping authorities, not comprehensive IPAWS.', 'needs_access'),
  candidate('epa-radnet', 'EPA RadNet radiation measurements', 'radiation_geophysics', 'radiation_measurement', 'epa-radnet-stations', 'https://www.epa.gov/radnet/learn-about-radnet', 'R17: Public dashboard/CSV documented; station units, quality flags and continuous versus laboratory product contracts need enrollment. Not a nuclear precursor detector.'),
  candidate('eurdep', 'EURDEP radiation context', 'radiation_geophysics', 'radiation_measurement', 'eurdep-national-stations', 'https://remon.jrc.ec.europa.eu/About/Rad-Data-Exchange', 'R18: Public maps may be delayed; automated contract unresolved. Not a rapid alert system; national stations may duplicate other radiation products.'),
  candidate('nasa-firms', 'NASA FIRMS thermal observations', 'imagery', 'satellite_thermal', 'nasa-firms-satellite-instruments', 'https://firms.modaps.eosdis.nasa.gov/api/', 'R19: API MAP_KEY required; acquisition/swath/cloud/quality semantics need enrollment. Fire hotspots do not identify detonation.', 'needs_access'),
  candidate('gpsjam', 'GPSJAM navigation context', 'service_telemetry', 'adsb_navigation_aggregate', 'adsb-exchange-heatmap', 'https://gpsjam.org/faq', 'R20: Daily 24-hour ADS-B-derived aggregate, overlapping aviation inputs, not independent live sensing. Automated dataset contract unresolved.'),
  candidate('cloudflare-radar', 'Cloudflare Radar connectivity', 'service_telemetry', 'connectivity_measurement', 'cloudflare-network', 'https://developers.cloudflare.com/radar/get-started/first-request/', 'R21: Radar Read API token and enrolled aggregation/geography required. Outages are not attack attribution.', 'needs_access'),
  candidate('ioda', 'IODA civilian connectivity', 'service_telemetry', 'connectivity_measurement', 'ioda-network-observations', 'https://ioda.inetintel.cc.gatech.edu/', 'R22: Public application identified; concrete API, coverage, methods, timing and shared inputs still need verification.'),
  candidate('eia-grid', 'EIA civilian grid context', 'service_telemetry', 'power_system_measurement', 'eia-balancing-authorities', 'https://www.eia.gov/electricity/gridmonitor/about', 'R23: Series and access/delay contract unresolved; balancing-authority reports may overlap utility notices. Not a validated rapid outage feed.'),
  candidate('polymarket', 'Polymarket public market context', 'attention_pricing', 'prediction_market', 'polymarket-public-news-attention', 'https://docs.polymarket.com/', 'R24: Public reads documented; enroll specific contract resolution/liquidity rules before observation. No trading; price is not a calibrated nuclear probability.'),
  candidate('google-trends', 'Google Trends attention research', 'attention_pricing', 'search_interest', 'google-search-sampling', 'https://developers.google.com/search/blog/2025/07/trends-api', 'R25: Limited alpha entitlement not audited; documented daily-or-coarser delayed data, not an immediate precursor stream.', 'needs_access'),
  candidate('nga-maritime', 'NGA maritime warnings', 'hazard_declarations', 'maritime_notices', 'national-navarea-coordinators', 'https://msi.nga.mil/NavWarnings', 'R26: Public JavaScript app identified; stable automated feed/cancellation contract unresolved. May repeat national NAVAREA notices.'),
  definition('faa-tfr', 'FAA temporary flight restrictions', 'warning_emissions', 'airspace_restriction', 'faa-tfr-geoserver', 'https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=300&outputFormat=application/json&srsname=EPSG:3857', 600, 3600,
    'R27: GeoServer WFS is the stable TFR contract; legacy /tfr2/* and /save_pages/* return 404, NOTAM Search returns 403 to non-US egress. Active snapshot; absence is not cancellation. EPSG:3857 geometry is metres, not degrees.', { adapter: 'tfr' }),
  definition('nrc-events', 'US NRC event notifications', 'radiation_geophysics', 'official_public_alert', 'us-nrc', 'https://www.nrc.gov/public-involve/rss?feed=event', 1800, 10800,
    'R28: Public RSS plus today/yesterday daily event reports; non-browser User-Agent required. Empty RSS channel title is legitimate. Missing daily pages leave emergency class unknown; historical monthly text is stale and unused. The edge 403s occasional bursts regardless of User-Agent (observed 2026-09-11), so this source is polled at half cadence and relies on the registry backoff for recovery.', { adapter: 'nrc_events' }),
  definition('nrc-reactor-status', 'US NRC reactor power status', 'radiation_geophysics', 'reactor_power_measurement', 'us-nrc', 'https://www.nrc.gov/public-involve/rss?feed=plant-status', 3600, 86400,
    'R29: Public daily unit power RSS; non-browser User-Agent required. Reported power is not a radiation measurement or evidence of an emergency.', { adapter: 'nrc_reactor' }),
  definition('iaea-news', 'IAEA news', 'public_reporting', 'official_news', 'iaea', 'https://www.iaea.org/feeds/news', 900, 7200,
    'R30: Public news RSS, including statements and press releases; authority reporting is not itself a verified local hazard.', { adapter: 'rss_feed' }),
  definition('who-outbreaks', 'WHO Disease Outbreak News', 'warning_emissions', 'official_public_alert', 'who', 'https://www.who.int/api/news/diseaseoutbreaknews?$top=25&$orderby=PublicationDateAndTime%20desc', 1800, 14400,
    'R31: Public OData JSON; no WHO DON RSS exists. Latest 25 published reports, not exhaustive surveillance or inferred outbreak onset.', { adapter: 'who_don' }),
  definition('ecdc-threats', 'ECDC Communicable Disease Threats Report', 'public_reporting', 'official_news', 'ecdc', 'https://www.ecdc.europa.eu/en/taxonomy/term/1505/feed', 3600, 604800,
    'R32: Public weekly CDTR RSS; HTTP 429 observed. Real research User-Agent and hourly polling; provider retry delays remain authoritative.', { adapter: 'rss_feed' }),
  definition('healthmap-alerts', 'HealthMap aggregate alerts', 'public_reporting', 'outbreak_aggregate', 'healthmap', 'https://www.healthmap.org/getAlerts.php', 1800, 7200,
    'R33: Public JSON body despite text/html Content-Type. Endpoint publishes no terms of service or rate limit; courtesy cadence no faster than 30 minutes. Aggregate markers are unverified underlying reports, without per-item timestamps.', { adapter: 'healthmap' }),
];

function sourceError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function requireShape(condition, message) {
  if (!condition) throw sourceError('invalid_source_response', `Source data shape: ${message}`);
}
function text(value, limit = 6000) {
  if (value && typeof value === 'object') value = value['#text'];
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, limit) : '';
}
function htmlText(value, limit = 6000) {
  if (value && typeof value === 'object') value = value['#text'];
  return text(typeof value === 'string' ? value.replace(/<[^>]*>/gu, ' ') : '', limit);
}
function iso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/iu.test(value)) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function list(value) { return value === undefined || value === null || value === '' ? [] : Array.isArray(value) ? value : [value]; }
function safeUrl(value) {
  requireShape(typeof value === 'string', 'missing source URL');
  const url = new URL(value);
  requireShape(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, 'unsafe source URL');
  return url.href;
}
function attribution(value) {
  const regions = THEATERS.filter(([, re]) => re.test(value)).map(([region]) => region);
  const topics = [];
  if (/nuclear|atomic|ядерн|核|핵|גרעיני|نووي|परमाणु/iu.test(value)) topics.push('nuclear_reporting');
  if (/missile|icbm|ракет|导弹|飛彈|미사일/iu.test(value)) topics.push('missile_reporting');
  if (/evacuat|embassy|shelter|civil emergency/iu.test(value)) topics.push('civil_protection');
  if (/radiat|radioactiv|radiolog/iu.test(value)) topics.push('radiation_reporting');
  return { region: regions.join('; ') || 'Global / unspecified', topics };
}
function observation(fields) {
  return { occurredAt: null, publishedAt: null, region: 'Global / unspecified', topics: [], kind: 'context', status: 'current', data: {}, ...fields };
}
function result(observations, metadata = {}) {
  return { observations, metadata: { returnedCount: observations.length, empty: observations.length === 0, ...metadata } };
}

async function fetchBody(url, options) {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(SOURCE_TIMEOUT_MS)]) : AbortSignal.timeout(SOURCE_TIMEOUT_MS);
  if (!options.fetchImpl && !sourceDispatcher) {
    // TLS establishment must fit the same total deadline, not fetch's shorter 10-second default.
    const { Agent } = require('undici');
    sourceDispatcher = new Agent({ connectTimeout: SOURCE_TIMEOUT_MS });
  }
  let response;
  try {
    response = await (options.fetchImpl || fetch)(url, { signal, dispatcher: options.fetchImpl ? undefined : sourceDispatcher, redirect: 'error', headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json, application/json, application/xml, application/rss+xml, text/xml;q=0.9' } });
  } catch (error) {
    if (signal.aborted) throw sourceError('source_timeout', 'Source collection was interrupted or exceeded its deadline.');
    throw sourceError('transport_error', `Source transport failed${['UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED'].includes(error?.cause?.code) ? ` (${error.cause.code})` : ''}.`);
  }
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    const now = options.now ?? Date.now();
    const retryAfterMs = retryAfter == null ? null : /^\d+$/.test(retryAfter.trim())
      ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
    await response.body?.cancel();
    throw sourceError(`http_${response.status}`, `Source HTTP ${response.status}${[401, 403].includes(response.status) ? ' (access gated)' : ''}${response.status === 429 ? ' (rate limited)' : ''}`, {
      httpStatus: response.status,
      ...(Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {}),
    });
  }
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw sourceError('invalid_source_response', 'Source response exceeds 8 MiB cap');
  }
  requireShape(response.body && typeof response.body.getReader === 'function', 'missing readable response body');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw sourceError('invalid_source_response', 'Source response exceeds remaining collection byte cap');
      chunks.push(value);
    }
  } catch (error) {
    throw Object.assign(error, { bytes });
  } finally { await reader.cancel(); reader.releaseLock(); }
  return { body: Buffer.concat(chunks, bytes).toString('utf8'), bytes };
}
function parseJson(body) {
  try { return JSON.parse(body); } catch { throw sourceError('invalid_source_response', 'Source response is not valid JSON'); }
}
function parseXml(body) {
  // Never expand custom entities or accept a DTD, including internal subsets.
  requireShape(!body.toUpperCase().includes('<!DOCTYPE') && !body.toUpperCase().includes('<!ENTITY'), 'XML DTD/entities are forbidden');
  requireShape(XMLValidator.validate(body) === true, 'invalid XML');
  return new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, processEntities: false, htmlEntities: false }).parse(body);
}

async function aviation(def, options) {
  requireShape(typeof options.publishedDir === 'string', 'publishedDir required');
  options.signal?.throwIfAborted();
  const handle = await fs.open(path.join(options.publishedDir, def.file), 'r');
  let bytes;
  try {
    const stat = await handle.stat();
    requireShape(stat.isFile() && stat.size <= MAX_BYTES, 'aggregate publication is not a bounded regular file');
    const buffer = Buffer.alloc(stat.size + 1);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    requireShape(read.bytesRead === stat.size, 'aggregate publication changed during read');
    bytes = buffer.subarray(0, read.bytesRead);
  } finally { await handle.close(); }
  options.signal?.throwIfAborted();
  const doc = parseJson(bytes.toString('utf8'));
  requireShape(doc.mode !== 'demo' && doc.current && doc.liveStatus, 'missing real aggregate snapshot');
  const c = doc.current;
  const s = doc.signals?.composite || {};
  const observed = iso(c.asOf || s.asOf || doc.liveStatus.latestSampledAt);
  const count = finite(s.actualConcurrentCount ?? c.concurrentCount);
  requireShape(observed && count !== null && count >= 0, 'aggregate count/sample timestamp missing');
  const alertLevel = text(s.alertLevel ?? c.alertLevel, 40);
  const modelReady = (s.modelReady ?? c.modelReady) === true;
  return result([observation({ externalId: 'aggregate-current', title: `${def.name}: ${count} airborne`,
    summary: `Existing aggregate aviation instrument; classification ${alertLevel || 'unavailable'}. Counts do not establish passengers, missions or nuclear intent.`,
    url: def.url, occurredAt: observed, region: 'Global', topics: ['aviation_activity', 'observation_context'],
    data: { cohort: def.id, concurrentCount: count, expectedConcurrentCount: finite(s.expectedConcurrentCount ?? c.baselineMean), sigmaShift: finite(s.sigmaShift ?? c.zScore), modelReady, alertLevel: alertLevel || null, emergencyLevel: finite(s.emergencyLevel ?? c.emergencyLevel), anomaly: modelReady && ['elevated', 'alarm'].includes(alertLevel), sampleCadenceMinutes: 30, sourceError: doc.liveStatus.lastError ? 'Existing aviation provider reports an error' : null },
  })], { sourceUpdatedAt: observed, publicationAt: iso(doc.snapshotGeneratedAt), bytes: bytes.length, coverage: 'Existing aggregate cohorts only; no individual data copied', sourceGap: Boolean(doc.liveStatus.lastError) });
}

function govuk(def, doc) {
  requireShape(doc && typeof doc.title === 'string' && doc.details && Array.isArray(doc.details.parts), 'GOV.UK title/details.parts missing');
  const parts = doc.details.parts.slice(0, 30).map(p => `${text(p.title, 200)}: ${htmlText(p.body, 16000)}`);
  const changed = text(doc.details.change_description, 4000);
  const history = list(doc.details.change_history).slice(0, 10).map(h => ({ publicTimestamp: iso(h.public_timestamp), note: text(h.note, 1000) }));
  return result([observation({ externalId: text(doc.content_id, 200) || def.id, title: text(doc.title, 300), summary: changed || text(doc.description, 4000) || 'Country advisory publication; consult original advice.',
    url: safeUrl(doc.web_url || `https://www.gov.uk${doc.base_path}`), publishedAt: iso(doc.public_updated_at), region: def.region, topics: ['travel_advice', ...attribution(changed).topics], kind: 'notice',
    data: { changeDescription: changed, advice: parts.join('\n\n').slice(0, 30000), contentDigest: createHash('sha256').update(JSON.stringify(doc.details.parts)).digest('hex'), changeHistory: history, firstPublishedAt: iso(doc.first_published_at), bodyTruncated: parts.join('\n\n').length > 30000 || doc.details.parts.length > 30 || doc.details.parts.some(p => typeof p.body === 'string' && p.body.length > 16000), validity: 'Advice as published; not inferred hazard onset' },
  })], { sourceUpdatedAt: iso(doc.public_updated_at), coverage: 'One country advisory, current body and latest ten published change notes' });
}
function easa(def, doc) {
  requireShape(doc.rss?.channel && typeof doc.rss.channel === 'object', 'EASA RSS channel missing');
  const items = list(doc.rss.channel.item);
  const observations = items.slice(0, MAX_ITEMS).map(item => {
    const title = text(item.title, 500);
    const guid = text(item.guid, 500);
    const url = safeUrl(text(item.link, 2000));
    requireShape(title && guid, 'EASA item title/guid missing');
    const summary = htmlText(item.description) || 'Conflict-zone bulletin listing. Consult original bulletin for applicability, validity and revisions.';
    const cancelled = /\b(?:cancelled|canceled|withdrawn)\b/iu.test(title);
    return observation({ externalId: guid.split(' on ')[0], title, summary, url, publishedAt: iso(item.pubDate), ...attribution(`${title} ${summary}`), topics: ['aviation_notice', 'conflict_zone'], kind: 'notice', status: cancelled ? 'cancelled' : 'current', data: { feedGuid: guid, revisionUrl: url, validity: 'unknown_from_rss', cancellationCoverage: 'Only explicit cancellation in listing; disappearance is not cancellation' } });
  });
  return result(observations, { scannedCount: items.length, truncated: items.length > MAX_ITEMS, coverage: 'RSS bulletin listings, not verified active restrictions' });
}
function faa(def, doc) {
  const root = doc.AIRPORT_STATUS_INFORMATION;
  requireShape(root && typeof root === 'object' && iso(root.Update_Time), 'FAA root/update time missing');
  const groups = list(root.Delay_type);
  requireShape(groups.length <= 50, 'FAA delay category limit exceeded');
  const categories = groups.map(group => {
    requireShape(typeof group.Name === 'string', 'FAA delay group name missing');
    const entries = [];
    function visit(node, depth = 0) {
      requireShape(depth <= 8, 'FAA XML nesting limit exceeded');
      for (const item of list(node)) {
        if (!item || typeof item !== 'object') continue;
        if (item.ARPT) {
          entries.push({ airport: text(item.ARPT, 12), reason: text(item.Reason, 2000), startText: text(item.Start, 200), endText: text(item.End_Time || item.Reopen, 200), average: text(item.Avg, 100), maximum: text(item.Max, 100), arrivalDeparture: list(item.Arrival_Departure).map(d => ({ type: text(d['@_Type'], 50), minimum: text(d.Min, 100), maximum: text(d.Max, 100), trend: text(d.Trend, 100) })) });
          requireShape(entries.length <= MAX_ITEMS, 'FAA item count cap exceeded');
        } else for (const value of Object.values(item)) if (value && typeof value === 'object') visit(value, depth + 1);
      }
    }
    visit(group);
    entries.sort((a, b) => a.airport.localeCompare(b.airport) || a.reason.localeCompare(b.reason));
    return { name: text(group.Name, 200), entries };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const total = categories.reduce((n, c) => n + c.entries.length, 0);
  requireShape(total <= MAX_ITEMS, 'FAA total item count cap exceeded');
  const contentDigest = createHash('sha256').update(JSON.stringify(categories)).digest('hex');
  let remaining = 52000;
  let omittedCount = 0;
  for (const category of categories) {
    category.listedCount = category.entries.length;
    category.entries = category.entries.filter(entry => {
      const size = JSON.stringify(entry).length;
      if (size > remaining) { omittedCount++; return false; }
      remaining -= size;
      return true;
    });
  }
  return result([observation({ externalId: 'nas-current-status', title: 'FAA civil airport disruption snapshot', summary: categories.map(c => `${c.name}: ${c.listedCount}`).join('; ') || 'FAA lists no delay categories in this snapshot; not an all-clear assessment.', url: def.url, region: 'United States', topics: ['civil_aviation_disruption', 'weather_confound'], data: { categories, total, omittedCount, contentDigest, validity: 'Current listings only; omitted programs are no longer listed, not independently confirmed resolved' } })], { sourceUpdatedAt: iso(root.Update_Time), listedPrograms: total, omittedCount, truncated: omittedCount > 0, coverage: 'United States civil NAS status; event start times not inferred. Details bounded to 52KB, category totals retain all listed programs.' });
}

const US_STATE_CODES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI UM'.split(' '));
const SAME_STATES = Object.fromEntries('01:AL 02:AK 04:AZ 05:AR 06:CA 08:CO 09:CT 10:DE 11:DC 12:FL 13:GA 15:HI 16:ID 17:IL 18:IN 19:IA 20:KS 21:KY 22:LA 23:ME 24:MD 25:MA 26:MI 27:MN 28:MS 29:MO 30:MT 31:NE 32:NV 33:NH 34:NJ 35:NM 36:NY 37:NC 38:ND 39:OH 40:OK 41:OR 42:PA 44:RI 45:SC 46:SD 47:TN 48:TX 49:UT 50:VT 51:VA 53:WA 54:WV 55:WI 56:WY 60:AS 66:GU 69:MP 72:PR 74:UM 78:VI'.split(' ').map(value => value.split(':')));
function capTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return iso(value);
}
async function nws(def, options) {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(SOURCE_TIMEOUT_MS)]) : AbortSignal.timeout(SOURCE_TIMEOUT_MS);
  const lanes = ['active', 'history'].map(name => {
    const url = new URL(def.url);
    url.searchParams.set('limit', '250');
    url.searchParams.set('event', CIVIL_EVENTS.join(','));
    if (name === 'active') url.searchParams.set('active', 'true');
    else url.searchParams.set('start', new Date(options.now - 7 * 86400000).toISOString());
    return { name, next: url.href, pages: 0, scannedCount: 0, error: null };
  });
  let sourceUpdatedAt = null;
  let bytes = 0;
  let scannedCount = 0;
  let excludedCount = 0;
  let pages = 0;
  let contentTruncations = 0;
  let geographyTruncations = 0;
  const observations = new Map();
  const activeIds = new Set();
  let firstError = null;
  let retryAfterMs = 0;
  let rateLimited = false;
  // Alternate lanes so a large active snapshot cannot starve cancellation history.
  while (pages < 4 && lanes.some(lane => lane.next && !lane.error)) {
    for (const lane of lanes) {
      if (!lane.next || lane.error || pages >= 4) continue;
      const pageItems = new Map();
      const priorCounts = { scannedCount, excludedCount, contentTruncations, geographyTruncations, laneScanned: lane.scannedCount };
      pages++;
      try {
      requireShape(!signal.aborted && bytes < MAX_BYTES, 'NWS collection deadline or byte cap reached');
      const response = await fetchBody(lane.next, { ...options, signal, maxBytes: MAX_BYTES - bytes });
      bytes += response.bytes;
      const doc = parseJson(response.body);
      requireShape(doc.type === 'FeatureCollection' && Array.isArray(doc.features), 'NWS FeatureCollection missing');
      requireShape(doc.features.length <= 250, 'NWS page exceeds requested limit');
      const updated = capTime(doc.updated);
      // Commit only after the complete page, including pagination, validates.
      for (const feature of doc.features) {
        const p = feature.properties;
        requireShape(p && typeof p.id === 'string' && typeof p.event === 'string' && typeof p.status === 'string' && typeof p.messageType === 'string', 'NWS CAP identity/type missing');
        scannedCount++;
        lane.scannedCount++;
        if (!CIVIL_EVENTS.includes(p.event)) { excludedCount++; continue; }
        requireShape(['Actual', 'Exercise', 'System', 'Test', 'Draft'].includes(p.status)
          && ['Public', 'Restricted', 'Private'].includes(p.scope)
          && ['Alert', 'Update', 'Cancel', 'Ack', 'Error'].includes(p.messageType), 'NWS CAP status, scope or message type malformed');
        const actual = p.status === 'Actual' && p.scope === 'Public';
        requireShape(p.id.trim() && p.id.length <= 1000, 'NWS CAP identifier missing or exceeds 1000 characters');
        requireShape(typeof p.sender === 'string' && p.sender.trim() && p.sender.length <= 1000, 'NWS CAP sender missing or exceeds 1000 characters');
        requireShape(p.references == null || Array.isArray(p.references), 'NWS CAP references malformed');
        const references = list(p.references).map(reference => {
          requireShape(reference && typeof reference === 'object' && !Array.isArray(reference) && typeof reference.identifier === 'string' && reference.identifier.trim() && reference.identifier.length <= 1000 && typeof reference.sender === 'string' && reference.sender.trim() && reference.sender.length <= 1000 && capTime(reference.sent), 'NWS CAP reference sender, identifier or sent missing or malformed');
          return { sender: reference.sender, identifier: reference.identifier, sent: capTime(reference.sent) };
        });
        requireShape(references.length <= 50 && JSON.stringify(references).length <= 30000, 'NWS CAP references exceed complete-reference guard; cancellation coverage unavailable');
        requireShape(p.areaDesc == null || (typeof p.areaDesc === 'string' && p.areaDesc.length <= 20000), 'NWS area description exceeds 20000-character guard or is malformed');
        const area = p.areaDesc || '';
        const stateCodes = new Set();
        const geocode = { UGC: [], SAME: [] };
        let geographyUnresolved = false;
        let geographyTruncated = false;
        for (const key of ['UGC', 'SAME']) {
          const codes = list(p.geocode?.[key]);
          if (codes.length > 1000) geographyTruncated = true;
          for (const code of codes.slice(0, 1000)) {
            if (typeof code !== 'string' || !(key === 'UGC' ? /^[A-Z]{2}[CZ]\d{3}$/ : /^\d{6}$/).test(code)) { geographyUnresolved = true; continue; }
            geocode[key].push(code);
            const state = key === 'UGC' ? code.slice(0, 2) : SAME_STATES[code.slice(1, 3)];
            if (US_STATE_CODES.has(state)) stateCodes.add(state);
            else geographyUnresolved = true;
          }
        }
        geographyUnresolved ||= !stateCodes.size || geographyTruncated;
        if (geographyTruncated) geographyTruncations++;
        const sentAt = capTime(p.sent);
        // CAP 1.2 §3.2.2: absent effective defaults to sent, not malformed input.
        const effectiveAt = p.effective == null ? sentAt : capTime(p.effective);
        const expiresAt = capTime(p.expires);
        const endsAt = capTime(p.ends);
        // No-expiry protective instructions remain unverified under our conservative recipient policy.
        // Cancel controls use sent/reference identity, not optional info/event-window fields.
        const timingValid = p.messageType === 'Cancel' ? Boolean(sentAt && references.length)
          : Boolean(sentAt && effectiveAt && expiresAt && (p.ends == null || endsAt) && Date.parse(expiresAt) > Date.parse(effectiveAt) && (endsAt == null || Date.parse(endsAt) >= Date.parse(effectiveAt)));
        requireShape([p.description, p.instruction, p.headline].every(value => value == null || typeof value === 'string'), 'NWS CAP text malformed');
        const data = { officialVersion: 2, messageId: p.id, sender: p.sender, event: p.event, capStatus: p.status, messageType: p.messageType, scope: p.scope, actual, test: p.status !== 'Actual', area, senderName: text(p.senderName, 300), severity: text(p.severity, 50), certainty: text(p.certainty, 50), urgency: text(p.urgency, 50), sentAt, effectiveAt, expiresAt, endsAt, timingValid, headline: p.headline || p.event, description: p.description || '', instruction: p.instruction || '', references, geocode, stateCodes: [...stateCodes].sort(), geographyUnresolved, geographyTruncated, contentTruncated: false, sourceInstructionOnly: true, nuclearIntentEstablished: false };
        // Preserve original line breaks and full instructions; clip only with an explicit flag.
        for (const key of ['description', 'instruction', 'headline']) {
          while (JSON.stringify(data).length > 64000 && data[key].length) {
            data.contentTruncated = true;
            data[key] = data[key].slice(0, Math.max(0, data[key].length - Math.max(256, JSON.stringify(data).length - 63900)));
          }
        }
        requireShape(JSON.stringify(data).length <= 64000, 'NWS CAP observation exceeds complete-data guard');
        if (data.contentTruncated) contentTruncations++;
        const item = observation({ externalId: p.id, title: text(p.headline, 500) || text(p.event, 500), summary: text(p.description), url: safeUrl(feature.id || p['@id']), occurredAt: capTime(p.onset), publishedAt: sentAt, region: `United States: ${text(area, 485)}`, topics: ['civil_protection', /Tsunami/iu.test(p.event) ? 'natural_hazard' : 'official_warning'], kind: actual ? 'official_alert' : 'context', status: p.messageType === 'Cancel' ? 'cancelled' : p.messageType === 'Update' ? 'updated' : 'current', data });
        const previous = pageItems.get(p.id);
        if (!previous || (item.publishedAt || '') >= (previous.publishedAt || '')) pageItems.set(p.id, item);
      }
      lane.next = doc.pagination?.next || null;
      if (lane.next) {
        const target = new URL(lane.next);
        requireShape(target.origin === 'https://api.weather.gov' && target.pathname === '/alerts' && !target.username && !target.password && !target.hash, 'NWS pagination leaves approved endpoint');
        lane.next = target.href;
      }
      lane.pages++;
      if (updated && (!sourceUpdatedAt || updated > sourceUpdatedAt)) sourceUpdatedAt = updated;
      for (const [id, item] of pageItems) {
        const previous = observations.get(id);
        if (!previous || (item.publishedAt || '') >= (previous.publishedAt || '')) observations.set(id, item);
        if (lane.name === 'active') activeIds.add(id);
      }
      } catch (error) {
        bytes += Number.isFinite(error.bytes) ? error.bytes : 0;
        firstError ||= error;
        if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) retryAfterMs = Math.max(retryAfterMs, Math.min(30 * 86400000, error.retryAfterMs));
        rateLimited ||= error.httpStatus === 429;
        lane.error = { code: error.code || 'invalid_source_response', message: text(error.message, 500), page: lane.pages + 1 };
        lane.next = null;
        ({ scannedCount, excludedCount, contentTruncations, geographyTruncations } = priorCounts);
        lane.scannedCount = priorCounts.laneScanned;
        // A provider delay or exhausted shared bound stops further requests in either lane.
        if (signal.aborted || rateLimited || retryAfterMs > 0 || /byte cap|MiB cap|remaining collection/iu.test(error.message || '')) {
          for (const pending of lanes) if (pending.next && !pending.error) pending.error = { code: rateLimited || retryAfterMs > 0 ? 'provider_delay' : 'collection_bound', message: rateLimited || retryAfterMs > 0 ? 'Source requested a retry delay.' : 'Shared deadline or byte bound reached.', page: pending.pages + 1 };
        }
      }
    }
  }
  if (!lanes.some(lane => lane.pages)) throw firstError || sourceError('invalid_source_response', 'No NWS page validated');
  const incompleteLanes = lanes.filter(lane => lane.next || lane.error).map(lane => ({ lane: lane.name, pages: lane.pages, scannedCount: lane.scannedCount, ...(lane.error || { code: 'page_bound', message: 'Four-page collection bound reached.', page: lane.pages + 1 }) }));
  return { ...result([...observations.values()].sort((a, b) => (a.publishedAt || '').localeCompare(b.publishedAt || '') || a.externalId.localeCompare(b.externalId)), { officialVersion: 2, sourceUpdatedAt, bytes, pages, scannedCount, excludedCount, contentTruncations, geographyTruncations, retryAfterMs, rateLimited, sourceGap: incompleteLanes.length > 0, incompleteLanes, truncated: incompleteLanes.length > 0 || contentTruncations > 0 || geographyTruncations > 0, activeCoverage: !lanes[0].next && !lanes[0].error, historyCoverage: !lanes[1].next && !lanes[1].error, coverage: 'Selected active civil alerts plus seven-day amendment history; at most four attempted pages and 1000 records. Snapshot absence is not cancellation. Not comprehensive IPAWS coverage.' }), activeIds: [...activeIds] };
}
function usgs(def, doc) {
  requireShape(doc.type === 'FeatureCollection' && Array.isArray(doc.features) && doc.metadata?.status === 200, 'USGS catalog envelope missing');
  requireShape(doc.features.length <= 10000, 'USGS feature cap exceeded');
  const selected = doc.features.filter(f => {
    requireShape(f.properties && typeof f.id === 'string' && typeof f.properties.type === 'string', 'USGS event identity/classification missing');
    if (!def.filterRelevant || finite(f.properties.mag) >= 4.5 || f.properties.type !== 'earthquake') return true;
    const [lon, lat] = Array.isArray(f.geometry?.coordinates) ? f.geometry.coordinates : [];
    return nearTestSiteCandidate(finite(f.properties.mag), finite(lat), finite(lon));
  }).sort((a, b) => (b.properties.time || 0) - (a.properties.time || 0) || a.id.localeCompare(b.id));
  return result(selected.slice(0, MAX_ITEMS).map(f => {
    const p = f.properties;
    return observation({ externalId: f.id, title: text(p.title, 500), summary: `USGS classification: ${p.type}; review status: ${text(p.status, 100)}. Seismic detection does not establish a nuclear event, and nondetection does not exclude an airburst.`, url: safeUrl(p.url), occurredAt: iso(p.time), publishedAt: iso(p.updated), ...attribution(text(p.place)), topics: ['seismic_event', 'scientific_context'], kind: 'measurement', status: p.status === 'deleted' ? 'cancelled' : 'current', data: { magnitude: finite(p.mag), magnitudeType: text(p.magType, 50), place: text(p.place, 500), classification: p.type, reviewStatus: text(p.status, 100), significance: finite(p.sig), alert: text(p.alert, 50) || null, tsunamiFlag: finite(p.tsunami), coordinates: Array.isArray(f.geometry?.coordinates) ? f.geometry.coordinates.slice(0, 3).map(finite) : null, network: text(p.net, 50), catalogUpdatedAt: iso(p.updated), publicationTimeMeaning: 'Catalog revision, not first publication', nuclearAttribution: 'not_established', deletionCoverage: 'Only explicit provider deletion; disappearance from rolling feed is not deletion' } });
  }), { sourceUpdatedAt: iso(doc.metadata.generated), scannedCount: doc.features.length, selectedCount: selected.length, truncated: selected.length > MAX_ITEMS, coverage: def.notes });
}
function noaa(def, doc) {
  requireShape(Array.isArray(doc) && doc.length > 0 && doc.length <= 1000, 'NOAA Kp rows missing or excessive');
  // Providers have served both named objects and a header/row table at this URL.
  let rows = doc;
  if (Array.isArray(doc[0])) {
    const header = doc[0];
    requireShape(header.includes('time_tag') && header.includes('Kp') && header.includes('station_count'), 'NOAA Kp table headers changed');
    rows = doc.slice(1).map(row => {
      requireShape(Array.isArray(row) && row.length === header.length, 'NOAA Kp table row malformed');
      return Object.fromEntries(header.map((key, index) => [key, row[index]]));
    });
  }
  const parsed = rows.map(row => {
    requireShape(row && typeof row.time_tag === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z)?$/u.test(row.time_tag), 'NOAA UTC time_tag missing');
    const time = iso(row.time_tag.endsWith('Z') ? row.time_tag : `${row.time_tag}Z`);
    const kp = typeof row.Kp === 'number' ? row.Kp : typeof row.Kp === 'string' && row.Kp.trim() ? Number(row.Kp) : NaN;
    const stations = typeof row.station_count === 'number' ? row.station_count : Number(row.station_count);
    requireShape(time && Number.isFinite(kp) && kp >= 0 && kp <= 9 && Number.isInteger(stations) && stations > 0, 'NOAA Kp/station value invalid');
    return { time, kp, stations };
  }).sort((a, b) => a.time.localeCompare(b.time));
  requireShape(parsed.length > 0, 'NOAA table contains no measurements');
  return result(parsed.slice(-24).map(row => observation({ externalId: row.time, title: `Planetary Kp ${row.kp}`, summary: `NOAA three-hour geomagnetic context, ${row.stations} contributing stations. Not an EMP detector or nuclear-intent measurement.`, url: def.url, occurredAt: row.time, region: 'Global', topics: ['space_weather', 'observation_context'], kind: 'measurement', data: { kp: row.kp, stationCount: row.stations, intervalHours: 3, timeBasis: 'NOAA UTC measurement bin; publication time unavailable' } })), { sourceUpdatedAt: parsed.at(-1).time, scannedCount: rows.length, windowed: rows.length > 24, coverage: 'Latest 24 supplied three-hour measurements; no inferred publication time' });
}
async function gdelt(def, options) {
  const url = new URL(def.url);
  const query = '("nuclear weapon" OR "nuclear war" OR "nuclear threat" OR "nuclear test" OR "missile attack" OR "embassy evacuation" OR "radiation leak" OR "chemical leak" OR "chemical cloud" OR "toxic cloud" OR "gas cloud" OR "iodine tablets" OR "Geiger counter")';
  for (const [key, value] of Object.entries({ query, mode: 'artlist', format: 'json', maxrecords: '100', timespan: '24h', sort: 'datedesc' })) url.searchParams.set(key, value);
  const response = await fetchBody(url.href, options);
  const doc = parseJson(response.body);
  requireShape(doc && Array.isArray(doc.articles) && doc.articles.length <= 100, 'GDELT article-list envelope missing/excessive (not a manifest)');
  const observations = new Map();
  let lastSeenAt = null;
  for (const article of doc.articles) {
    requireShape(typeof article.title === 'string' && typeof article.domain === 'string', 'GDELT title/publisher missing');
    const original = safeUrl(article.url);
    const seen = typeof article.seendate === 'string' && /^\d{8}T\d{6}Z$/u.test(article.seendate) ? iso(`${article.seendate.slice(0, 4)}-${article.seendate.slice(4, 6)}-${article.seendate.slice(6, 8)}T${article.seendate.slice(9, 11)}:${article.seendate.slice(11, 13)}:${article.seendate.slice(13, 15)}Z`) : null;
    if (seen && (!lastSeenAt || seen > lastSeenAt)) lastSeenAt = seen;
    const title = text(article.title, 1000);
    observations.set(original, observation({ externalId: original, title, summary: `${article.domain}: ${title}. Indexed reporting lead; original article has not been independently verified.`, url: original, ...attribution(title), topics: ['news_reporting', ...attribution(title).topics], kind: 'report', data: { publisher: text(article.domain, 300), publisherCountry: text(article.sourcecountry, 200), language: text(article.language, 100), indexSeenAt: seen, firstPublicationAt: null, fullArticleRetrieved: false, sharedUpstream: 'Potential syndication/republication; originating URL is not proof of independence' } }));
  }
  return result([...observations.values()], { bytes: response.bytes, scannedCount: doc.articles.length, truncated: doc.articles.length === 100, latestIndexSeenAt: lastSeenAt, query, windowHours: 24, coverage: 'Newest 100 indexed article titles/URLs; no pagination or exhaustive coverage. Empty article array means no returned matches, not no reporting.' });
}

async function bluesky(def, options) {
  requireShape(typeof WebSocket === 'function', 'Node22 WebSocket required for public Jetstream');
  let state = { seq: null, tracked: [] };
  if (options.cursor) {
    requireShape(typeof options.cursor === 'string' && Buffer.byteLength(options.cursor) <= 160000, 'Jetstream cursor exceeds cap');
    state = parseJson(options.cursor);
    requireShape(state && typeof state.seq === 'string' && /^\d+$/u.test(state.seq) && Array.isArray(state.tracked) && state.tracked.length <= 200, 'Jetstream durable cursor malformed');
  }
  const tracked = new Map();
  for (const entry of state.tracked) {
    requireShape(entry && typeof entry.uri === 'string' && typeof entry.title === 'string' && typeof entry.region === 'string' && Array.isArray(entry.topics), 'Jetstream correction state malformed');
    tracked.set(entry.uri, entry);
  }
  const initial = !state.seq;
  const url = new URL('wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents');
  url.searchParams.set('collections', 'app.bsky.feed.post');
  url.searchParams.set('kinds', 'commit');
  if (state.seq) url.searchParams.set('cursor', state.seq);
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const observations = new Map();
    let frames = 0;
    let bytes = 0;
    let latestEventAt = null;
    let earliestEventAt = null;
    let seq = state.seq;
    let evicted = 0;
    let settled = false;
    const finish = (error, stopReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      ws.close();
      if (error) { reject(error); return; }
      if (!seq || frames === 0) { reject(new Error('Jetstream supplied no commit progress within bounded poll')); return; }
      let cursor = JSON.stringify({ seq, tracked: [...tracked.values()] });
      while (Buffer.byteLength(cursor) > 150000 && tracked.size) {
        tracked.delete(tracked.keys().next().value);
        evicted++;
        cursor = JSON.stringify({ seq, tracked: [...tracked.values()] });
      }
      const output = result([...observations.values()], { scannedCount: frames, bytes, stopReason, sourceUpdatedAt: latestEventAt, earliestCommitAt: earliestEventAt, truncated: stopReason !== 'caught_up', backlog: stopReason !== 'caught_up', enrollmentMode: initial ? 'live_tail' : 'persisted_sequence', preEnrollmentCoverage: false, correctionTrackedCount: tracked.size, correctionEvictedCount: evicted, coverage: 'Public post commits selected lexically; no exhaustive claims, account dossiers or media verification. Deletes/edits covered only for latest 200 retained matches within 150KB cursor cap. Enrollment joins the live tail without a cursor and provides no pre-enrollment coverage; subsequent polls resume the exact saved sequence. Actual commit interval and backlog are reported. No automatic cursor reset on provider failure.' });
      output.cursor = cursor;
      resolve(output);
    };
    const abort = () => finish(options.signal.reason || new Error('Jetstream aborted'));
    const timer = setTimeout(() => finish(null, 'time_cap'), 20000);
    options.signal?.addEventListener('abort', abort, { once: true });
    ws.addEventListener('error', () => finish(new Error('Jetstream public connection failed; no alternate access attempted')));
    ws.addEventListener('close', () => { if (!settled) finish(new Error('Jetstream closed before bounded poll completed')); });
    ws.addEventListener('message', event => {
      if (settled) return;
      try {
        requireShape(typeof event.data === 'string', 'Jetstream expected JSON text frame');
        const size = Buffer.byteLength(event.data);
        if (bytes + size > MAX_BYTES) { finish(null, 'byte_cap'); return; }
        bytes += size;
        const envelope = parseJson(event.data);
        requireShape(envelope.$type === 'message' && envelope.payload && envelope.payload.$type === 'network.bsky.jetstream.subscribeEvents#commit', 'Jetstream v2 commit envelope missing (including provider error/control frame)');
        const e = envelope.payload;
        requireShape(Number.isSafeInteger(e.seq) && e.seq >= 0 && iso(e.time), 'Jetstream sequence/time missing');
        requireShape(e.collection === 'app.bsky.feed.post' && ['create', 'update', 'delete'].includes(e.operation), 'Jetstream collection/operation unexpected');
        requireShape(typeof e.did === 'string' && /^did:(?:plc:[a-z2-7]+|web:[A-Za-z0-9.:%_-]+)$/u.test(e.did) && typeof e.rkey === 'string' && /^[A-Za-z0-9._~:-]+$/u.test(e.rkey), 'Jetstream record identity malformed');
        if (seq && BigInt(e.seq) < BigInt(seq)) throw new Error('Jetstream cursor moved backwards; refusing silent gap/reset');
        if (String(e.seq) === state.seq) return; // Inclusive resume replays the already committed boundary.
        const uri = `at://${e.did}/app.bsky.feed.post/${e.rkey}`;
        const previous = tracked.get(uri);
        if (e.operation !== 'delete') requireShape(e.record && typeof e.record.text === 'string', 'Jetstream post text missing');
        const body = e.record?.text || '';
        const matched = POST_RELEVANCE.test(body) || CBRN_EVENT_RELEVANCE.test(body);
        if (matched || previous) {
          const labels = matched ? attribution(body) : previous;
          const title = matched ? text(body, 200) : previous.title;
          const cancelled = e.operation === 'delete';
          observations.set(uri, observation({ externalId: uri, title, summary: cancelled ? 'Previously observed public post was deleted. Deletion does not establish why.' : text(body, 6000), url: `https://bsky.app/profile/${encodeURIComponent(e.did)}/post/${encodeURIComponent(e.rkey)}`, publishedAt: cancelled ? iso(e.time) : iso(e.record.createdAt), region: labels.region, topics: ['public_post', ...labels.topics.filter(t => t !== 'public_post')], kind: 'report', status: cancelled ? 'cancelled' : e.operation === 'update' ? 'updated' : 'current', data: { uri, cid: typeof e.cid === 'string' ? e.cid : null, revision: typeof e.rev === 'string' ? e.rev : null, operation: e.operation, sourceCommitAt: iso(e.time), claimedCreatedAt: iso(e.record?.createdAt), claimVerified: false, matchesCurrentFilter: matched, deletionMeaning: cancelled ? 'Deleted source record, not disproven claim' : null, languages: list(e.record?.langs).filter(v => typeof v === 'string').slice(0, 5), mediaRetrieved: false } }));
          tracked.delete(uri);
          if (!cancelled) tracked.set(uri, { uri, title, region: labels.region, topics: labels.topics });
          while (tracked.size > 200) { tracked.delete(tracked.keys().next().value); evicted++; }
        }
        seq = String(e.seq);
        latestEventAt = iso(e.time);
        earliestEventAt ||= latestEventAt;
        frames++;
        if (Date.parse(latestEventAt) >= options.now) finish(null, 'caught_up');
        else if (frames >= 20000 || observations.size >= MAX_ITEMS) finish(null, 'item_cap');
      } catch (error) { finish(error); }
    });
  });
}

function cbrnText(value, limit = 6000) {
  if (value && typeof value === 'object') value = value['#text'];
  return text(typeof value === 'string' ? value.replace(/<[^<>]{0,4096}>/gu, ' ') : '', limit);
}

async function cbrnRss(def, options) {
  const response = await fetchBody(def.url, { ...options, maxBytes: MAX_BYTES });
  const channel = parseXml(response.body).rss?.channel;
  requireShape(channel && typeof channel === 'object' && !Array.isArray(channel), 'CBRN RSS channel missing');
  const items = list(channel.item);
  requireShape(items.length > 0 && items.every(item => item && typeof item === 'object' && !Array.isArray(item)), 'CBRN RSS items missing or malformed');
  return { channel, items, bytes: response.bytes };
}

function deduplicateObservations(observations, timestamps = []) {
  const groups = new Map();
  let droppedCount = 0;
  for (const [index, item] of observations.entries()) {
    const timestamp = Number.isFinite(timestamps[index]) ? timestamps[index] : -Infinity;
    const signature = JSON.stringify([item.title, item.summary, item.url, item.region, item.data]);
    const group = groups.get(item.externalId);
    if (!group) {
      groups.set(item.externalId, { item, timestamp, signature, conflictingCount: 0 });
      continue;
    }
    droppedCount++;
    if (signature !== group.signature) group.conflictingCount++;
    if (timestamp > group.timestamp) {
      group.item = item;
      group.timestamp = timestamp;
    }
  }
  return {
    observations: [...groups.values()].map(group => {
      if (group.conflictingCount) group.item.data.conflictingCount = group.conflictingCount;
      return group.item;
    }),
    droppedCount,
  };
}

async function rssFeed(def, options) {
  const { channel, items, bytes } = await cbrnRss(def, options);
  const feedTitle = text(channel.title, 500);
  requireShape(feedTitle, 'authority RSS title missing');
  const observations = items.slice(0, MAX_ITEMS).map(item => {
    const title = text(item.title, 500);
    const description = cbrnText(item.description);
    const externalId = text(item.guid, 2000) || text(item.link, 2000);
    requireShape(title && externalId, 'authority RSS item title/identity missing');
    const labels = attribution(`${title} ${description}`);
    return observation({ externalId, title, summary: `${feedTitle}: ${description || 'Description not supplied.'}`, url: safeUrl(text(item.link, 2000)), publishedAt: iso(item.pubDate), region: labels.region, topics: ['cbrn_official', ...labels.topics], kind: 'report' });
  });
  const deduplicated = deduplicateObservations(observations, items.slice(0, MAX_ITEMS).map(item => Date.parse(item.pubDate)));
  return result(deduplicated.observations, { bytes, scannedCount: items.length, duplicateItemsDropped: deduplicated.droppedCount, sourceUpdatedAt: iso(channel.lastBuildDate) || iso(channel.pubDate), truncated: items.length > MAX_ITEMS, coverage: `Authority RSS listings; publication times only when supplied with timezone, not hazard onset. Providers may republish items under a stable guid; ${deduplicated.droppedCount} duplicate items dropped, keeping the newest parseable pubDate (first seen on ties or missing dates). Conflicting content is counted in payload conflictingCount.` });
}

async function nrcReactor(def, options) {
  const { channel, items, bytes } = await cbrnRss(def, options);
  const observations = items.slice(0, MAX_ITEMS).map(item => {
    const title = text(item.title, 500);
    const match = /^(.+?)\s+-\s+(\d+(?:\.\d+)?)%\s+power$/iu.exec(title);
    requireShape(match && Number.isFinite(Number(match[2])), 'NRC unit/power title malformed');
    const unit = match[1].trim();
    const powerPercent = Number(match[2]);
    return observation({ externalId: unit, title, summary: `${def.name}: ${title}. Power status alone does not establish an emergency.`, url: safeUrl(text(item.link, 2000)), publishedAt: iso(item.pubDate), region: 'United States', topics: ['nuclear_facility', 'radiological_event'], kind: 'measurement', data: { unit, powerPercent } });
  });
  return result(observations, { bytes, scannedCount: items.length, sourceUpdatedAt: iso(channel.lastBuildDate) || iso(channel.pubDate), truncated: items.length > MAX_ITEMS, coverage: 'Reported reactor power per stable unit name; no inferred measurement time or emergency classification.' });
}

function nrcDaily(body, url) {
  const markers = [...body.matchAll(/\bEvent Number:\s*(\d{4,8})\b/gu)];
  requireShape(markers.length > 0 && markers.length <= MAX_ITEMS, 'NRC daily event blocks missing or excessive');
  return markers.map((marker, index) => {
    const block = body.slice(marker.index, Math.min(markers[index + 1]?.index ?? body.length, marker.index + 16000));
    const fields = new Map();
    for (const match of block.matchAll(/<b>\s*([^<>]{1,80}):\s*<\/b>([^<]{0,1000})/giu)) {
      const key = text(match[1], 80);
      if (!fields.has(key)) fields.set(key, text(match[2].replace(/&nbsp;/gu, ' '), 1000) || null);
    }
    const emergencyClass = fields.get('Emergency Class') || null;
    return { externalId: marker[1], facility: fields.get('Facility') || fields.get('Site') || fields.get('Licensee') || fields.get('Rep Org') || null, state: fields.get('State') || null, emergencyClass, emergencyClassSource: emergencyClass ? url : null, eventDateText: fields.get('Event Date') || null, eventTimeText: fields.get('Event Time') || null, dailyReportUrl: url };
  });
}

async function nrcEvents(def, options) {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(SOURCE_TIMEOUT_MS)]) : AbortSignal.timeout(SOURCE_TIMEOUT_MS);
  const { channel, items, bytes: rssBytes } = await cbrnRss(def, { ...options, signal });
  let bytes = rssBytes;
  const observations = new Map();
  for (const item of items.slice(0, MAX_ITEMS)) {
    const title = text(item.title, 500);
    const match = /^(\d{4,8})\s*-\s*(.+)$/u.exec(title);
    requireShape(match, 'NRC event number/licensee missing');
    observations.set(match[1], observation({ externalId: match[1], title, summary: `${def.name}: ${cbrnText(item.description) || 'Description not supplied.'}`, url: safeUrl(text(item.link, 2000)), publishedAt: iso(item.pubDate), region: 'United States / state unspecified', topics: ['cbrn_official', 'nuclear_facility'], kind: 'official_alert', data: { facility: match[2], state: null, emergencyClass: null, emergencyClassSource: null, eventDateText: null, eventTimeText: null } }));
  }
  const dailyGaps = [];
  const enriched = new Set();
  let scannedCount = items.length;
  for (let offset = 0; offset < 2; offset++) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(options.now - offset * 86400000)).replaceAll('-', '');
    const url = `https://www.nrc.gov/reading-rm/doc-collections/event-status/event/${day.slice(0, 4)}/${day}en`;
    try {
      requireShape(!signal.aborted && bytes < MAX_BYTES, 'NRC shared deadline or byte cap reached');
      let httpStatus;
      const response = await fetchBody(url, { ...options, signal, maxBytes: MAX_BYTES - bytes, fetchImpl: async (request, init) => {
        const fetched = await (options.fetchImpl || fetch)(request, { ...init, dispatcher: options.fetchImpl ? undefined : sourceDispatcher });
        httpStatus = fetched.status;
        return fetched;
      } });
      bytes += response.bytes;
      requireShape(httpStatus === 200, 'NRC daily report requires HTTP 200');
      const entries = nrcDaily(response.body, url);
      scannedCount += entries.length;
      for (const entry of entries) {
        if (enriched.has(entry.externalId)) continue; // Today's report supersedes yesterday's copy.
        enriched.add(entry.externalId);
        const previous = observations.get(entry.externalId);
        observations.set(entry.externalId, observation({ ...previous, externalId: entry.externalId, title: previous?.title || `${entry.externalId} - ${entry.facility || 'Facility not supplied'}`, summary: `${def.name}: emergency class ${entry.emergencyClass || 'not supplied'}. Event date: ${entry.eventDateText || 'not supplied'}; time: ${entry.eventTimeText || 'not supplied'}.`, url: previous?.url || url, region: entry.state ? `United States: ${entry.state}` : 'United States / state unspecified', topics: ['cbrn_official', 'nuclear_facility'], kind: 'official_alert', data: { ...entry, facility: entry.facility || previous?.data.facility || null } }));
      }
    } catch (error) {
      bytes += Number.isFinite(error.bytes) ? error.bytes : 0;
      dailyGaps.push({ url, code: error.code || 'invalid_source_response', message: text(error.message, 500), retryAfterMs: error.retryAfterMs ?? null });
      if (error.httpStatus === 403 || error.httpStatus === 429 || error.retryAfterMs > 0 || signal.aborted || bytes >= MAX_BYTES) {
        if (offset === 0) dailyGaps.push({ code: 'daily_request_not_attempted', message: 'Yesterday report skipped after provider refusal/delay or shared collection bound.' });
        break;
      }
    }
  }
  return result([...observations.values()].slice(0, MAX_ITEMS), { bytes, scannedCount, sourceUpdatedAt: iso(channel.lastBuildDate) || iso(channel.pubDate), sourceGap: dailyGaps.length > 0, dailyGaps, truncated: items.length > MAX_ITEMS || observations.size > MAX_ITEMS, coverage: 'NRC RSS plus today/yesterday daily reports using US Eastern calendar dates. Direct canonical https://www.nrc.gov/reading-rm/doc-collections/event-status/event/{YYYY}/{YYYYMMDD}en (without .html); redirects are rejected and recorded as daily-page failures. Unknown emergency class stays null. Event date/time remains verbatim, not inferred UTC. Snapshot absence is not cancellation.' });
}

async function tfr(def, options) {
  const response = await fetchBody(def.url, { ...options, maxBytes: MAX_BYTES });
  const doc = parseJson(response.body);
  requireShape(doc?.type === 'FeatureCollection' && Array.isArray(doc.features), 'TFR FeatureCollection missing');
  let geometryTruncations = 0;
  const groups = new Map();
  let duplicatePolygonsMerged = 0;
  for (const feature of doc.features.slice(0, MAX_ITEMS)) {
    const p = feature?.properties;
    const geometry = feature?.geometry;
    requireShape(p && typeof p.NOTAM_KEY === 'string' && p.NOTAM_KEY.trim() && typeof p.TITLE === 'string' && p.TITLE.trim(), 'TFR NOTAM key/title missing');
    requireShape(geometry && ['Polygon', 'MultiPolygon'].includes(geometry.type), 'TFR polygon missing');
    const ring = geometry.type === 'Polygon' ? geometry.coordinates?.[0] : geometry.coordinates?.[0]?.[0];
    requireShape(Array.isArray(ring) && ring.length >= 3, 'TFR first polygon ring malformed');
    const vertices = ring.slice(0, 2000);
    if (ring.length > 2000 || (geometry.type === 'MultiPolygon' && geometry.coordinates.length > 1)) geometryTruncations++;
    let centroidLat = 0;
    let centroidLon = 0;
    for (const coordinate of vertices) {
      requireShape(Array.isArray(coordinate) && finite(coordinate[0]) !== null && finite(coordinate[1]) !== null && Math.abs(coordinate[0]) <= Math.PI * 6378137 && Math.abs(coordinate[1]) <= Math.PI * 6378137, 'TFR Mercator coordinate malformed');
      centroidLon += coordinate[0] / 6378137 * 180 / Math.PI;
      centroidLat += (2 * Math.atan(Math.exp(coordinate[1] / 6378137)) - Math.PI / 2) * 180 / Math.PI;
    }
    centroidLat /= vertices.length;
    centroidLon /= vertices.length;
    const title = text(p.TITLE, 1000);
    const reason = /\b(HAZARD|SECURITY|SPACE OPERATION|AIR SHOW|FIRE|VIP|LAUNCH)\b/iu.exec(title)?.[1].toUpperCase() || null;
    const lastModified = text(p.LAST_MODIFICATION_DATETIME, 100) || null;
    const state = text(p.STATE, 100) || null;
    const externalId = p.NOTAM_KEY;
    const centroid = [Number(centroidLat.toFixed(4)), Number(centroidLon.toFixed(4))];
    const group = groups.get(externalId);
    if (group) {
      duplicatePolygonsMerged++;
      const data = group.data;
      if (title !== data.title || state !== data.state || lastModified !== data.lastModified || reason !== data.reason) data.conflictingCount++;
      data.polygonCount++;
      data.centroidLat += centroidLat;
      data.centroidLon += centroidLon;
      if (data.centroids.length < 12) data.centroids.push(centroid);
    } else {
      groups.set(externalId, observation({ externalId, title, summary: `FAA active TFR: ${title}. Snapshot absence is not cancellation.`, url: def.url, region: state || 'United States / state unspecified', topics: ['airspace_restriction', 'cbrn_official'], kind: reason ? 'official_alert' : 'context', data: { notamKey: externalId, title, state, centroidLat, centroidLon, lastModified, reason, polygonCount: 1, centroids: [centroid], conflictingCount: 0 } }));
    }
  }
  const observations = [...groups.values()];
  for (const { data } of observations) {
    data.centroidLat /= data.polygonCount;
    data.centroidLon /= data.polygonCount;
  }
  return result(observations, { bytes: response.bytes, scannedCount: doc.features.length, duplicatePolygonsMerged, sourceUpdatedAt: null, truncated: doc.features.length >= 300 || geometryTruncations > 0, geometryTruncations, coverage: `Active WFS snapshot, requested cap 300. ${duplicatePolygonsMerged} duplicate polygon rows merged by NOTAM key, averaging per-feature centroids; first title/state/modification/reason retained and disagreements counted in payload conflictingCount. Approximate vertex-average centroid of first exterior ring, at most 2000 vertices; not full area centroid. Audit centroids rounded to 4 decimals and capped at 12 per key. Modification time preserved without guessing timezone. Absence is not cancellation.` });
}

async function whoDon(def, options) {
  const response = await fetchBody(def.url, { ...options, maxBytes: MAX_BYTES });
  const doc = parseJson(response.body);
  requireShape(doc && Array.isArray(doc.value) && doc.value.length > 0, 'WHO DON value array missing/empty');
  const observations = doc.value.slice(0, MAX_ITEMS).map(item => {
    requireShape(item && (typeof item.DonId === 'string' || Number.isSafeInteger(item.DonId)) && String(item.DonId).trim() && text(item.Title) && typeof item.ItemDefaultUrl === 'string', 'WHO DON identity/title/slug missing');
    const slug = item.ItemDefaultUrl.split('/').filter(Boolean).at(-1);
    requireShape(slug && /^[A-Za-z0-9._~-]+$/u.test(slug) && slug !== '.' && slug !== '..', 'WHO DON slug malformed');
    const data = { contentTruncated: false };
    for (const field of ['Overview', 'Assessment', 'Advice']) {
      requireShape(item[field] == null || typeof item[field] === 'string', `WHO ${field} malformed`);
      data[field.toLowerCase()] = item[field] == null ? null : cbrnText(item[field], 12000);
      data.contentTruncated ||= typeof item[field] === 'string' && cbrnText(item[field], 12001).length > 12000;
    }
    return observation({ externalId: String(item.DonId), title: text(item.Title, 500), summary: cbrnText(item.Summary) || 'Summary not supplied.', url: safeUrl(`https://www.who.int/emergencies/disease-outbreak-news/item/${slug}`), publishedAt: iso(item.PublicationDateAndTime), region: attribution(`${item.Title} ${cbrnText(item.Summary)}`).region, topics: ['biological_outbreak', 'cbrn_official'], kind: 'official_alert', data });
  });
  return result(observations, { bytes: response.bytes, scannedCount: doc.value.length, sourceUpdatedAt: observations.map(item => item.publishedAt).filter(Boolean).sort().at(-1) || null, truncated: doc.value.length >= 25 || Boolean(doc['@odata.nextLink']) || observations.some(item => item.data.contentTruncated), coverage: 'Latest 25 WHO DON publications; no exhaustive outbreak coverage or inferred event onset. Overview/assessment/advice individually capped at 12000 characters.' });
}

async function healthmap(def, options) {
  const response = await fetchBody(def.url, { ...options, maxBytes: MAX_BYTES });
  const doc = parseJson(response.body);
  requireShape(doc && Array.isArray(doc.markers) && doc.markers.length > 0, 'HealthMap marker array missing/empty');
  const observations = doc.markers.slice(0, 100).map(marker => {
    requireShape(marker && Array.isArray(marker.alertids) && marker.alertids.length > 0, 'HealthMap alert identifiers missing');
    const alertIds = marker.alertids.slice(0, 20).map(id => {
      requireShape((typeof id === 'string' && id.trim()) || Number.isSafeInteger(id), 'HealthMap alert identifier malformed');
      return String(id);
    });
    const placeName = cbrnText(marker.place_name, 500) || null;
    const label = cbrnText(marker.label, 500);
    requireShape(label || placeName, 'HealthMap marker label/place missing');
    return observation({ externalId: alertIds[0], title: label || placeName, summary: `${label || 'Label not supplied'}; ${placeName || 'Place not supplied'}. Aggregate marker; underlying report not verified.`, url: def.url, region: placeName || 'Place not supplied', occurredAt: null, topics: ['biological_outbreak', 'public_reporting'], kind: 'report', data: { lat: finite(marker.lat), lon: finite(marker.lon), placeName, alertIds, alertIdsTruncated: marker.alertids.length > 20, sourceNote: 'aggregate marker; underlying report not verified' } });
  });
  const deduplicated = deduplicateObservations(observations);
  return result(deduplicated.observations, { bytes: response.bytes, scannedCount: doc.markers.length, duplicateMarkersDropped: deduplicated.droppedCount, sourceUpdatedAt: null, truncated: doc.markers.length > 100 || observations.some(item => item.data.alertIdsTruncated), coverage: `First 100 aggregate markers, at most 20 alert IDs each. ${deduplicated.droppedCount} duplicate markers dropped by alert ID, keeping the first in provider order without merging places; disagreements counted in payload conflictingCount. Aggregate carries no per-item timestamp; underlying reports not verified. Courtesy polling at least 30 minutes apart.` });
}

async function collectSource(definitionValue, options = {}) {
  // The registry, not callers or model text, selects network/file destinations.
  const def = SOURCE_DEFINITIONS.find(source => source.id === definitionValue?.id);
  requireShape(def, 'unknown source definition');
  if (!def.enabled) throw new Error(`Source disabled: ${def.accessStatus}; ${def.notes}`);
  const settings = { ...options, now: options.now ?? Date.now() };
  requireShape(Number.isFinite(settings.now), 'collection clock invalid');
  settings.signal?.throwIfAborted();
  if (def.adapter === 'aviation') return aviation(def, settings);
  if (def.adapter === 'nws') return nws(def, settings);
  if (def.adapter === 'gdelt') return gdelt(def, settings);
  if (def.adapter === 'bluesky') return bluesky(def, settings);
  if (def.adapter === 'rss_feed') return rssFeed(def, settings);
  if (def.adapter === 'nrc_events') return nrcEvents(def, settings);
  if (def.adapter === 'nrc_reactor') return nrcReactor(def, settings);
  if (def.adapter === 'tfr') return tfr(def, settings);
  if (def.adapter === 'who_don') return whoDon(def, settings);
  if (def.adapter === 'healthmap') return healthmap(def, settings);
  const response = await fetchBody(def.url, settings);
  const xml = ['easa', 'faa'].includes(def.adapter);
  const doc = xml ? parseXml(response.body) : parseJson(response.body);
  const parsers = { govuk, easa, faa, usgs, noaa };
  requireShape(parsers[def.adapter], 'enabled source has no collector');
  const output = parsers[def.adapter](def, doc);
  output.metadata.bytes = response.bytes;
  return output;
}

module.exports = { SOURCE_DEFINITIONS, collectSource, US_STATE_CODES };
