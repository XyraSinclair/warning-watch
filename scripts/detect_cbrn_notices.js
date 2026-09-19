#!/usr/bin/env node

const path = require('node:path');
const Database = require('better-sqlite3');
const { loadEnvFile } = require('../server/env');
loadEnvFile();
if (process.env.EWS_WATCH_ENV_PATH) loadEnvFile(process.env.EWS_WATCH_ENV_PATH);
const { KIND, openCbrnDb, haversineKm, writeAlarmState, buildCbrnEvent, insertCbrnEvent } = require('./cbrn_lib');
const { regions } = require('../config/cbrn-regions.json');
const lexicon = require('../config/cbrn-lexicon.json');
const { assessSeismicEvent, SHALLOW_KM } = require('../server/detonation-rule');
const SOURCES = ['nws-civil-alerts', 'nrc-events', 'nrc-reactor-status', 'faa-tfr', 'who-outbreaks', 'ecdc-threats', 'healthmap-alerts', 'iaea-news', 'usgs-significant', 'usgs-relevant'];
// A catalogue event older than this is history, not a detection.
const SEISMIC_MAX_AGE_MS = 7 * 24 * 3600000;
const RANK = { watch: 1, elevated: 3, high: 4, critical: 5 };

function options(argv, minutes = 1440) {
  const result = { watchDb: process.env.EWS_WATCH_DB_PATH || path.resolve(__dirname, '../data/ews-watch.sqlite'), eventsDb: process.env.EWS_DB_PATH || path.resolve(__dirname, '../data/ews-main.sqlite'), cbrnDb: process.env.EWS_CBRN_DB_PATH, minutes, dryRun: false };
  const names = { '--watch-db': 'watchDb', '--events-db': 'eventsDb', '--cbrn-db': 'cbrnDb', '--minutes': 'minutes' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') result.dryRun = true;
    else if (names[arg] && argv[index + 1] && !argv[index + 1].startsWith('--')) result[names[arg]] = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  result.minutes = Number(result.minutes);
  if (!Number.isSafeInteger(result.minutes) || result.minutes < 1 || result.minutes > 20160) throw new Error('--minutes must be an integer from 1 to 20160.');
  return result;
}

// Unicode boundaries prevent short agents such as VX from matching inside words.
function matcher(term) {
  const escaped = term.normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term);
  return new RegExp(cjk ? escaped : `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
}
const agents = lexicon.agents.map((term) => [term, matcher(term)]);

function detect(watch, settings, now = Date.now()) {
  const summary = { detector: 'cbrn_notices', dry_run: settings.dryRun, heads: {}, scanned: {}, matched: {}, events_written: 0, events_escalated: 0, invalid: 0, unavailable: [], regions: regions.map((region) => region.id) };
  const events = [];
  const states = [];
  const trips = [];
  const since = now - settings.minutes * 60000;
  const prior = watch.prepare('SELECT observation, observed_at FROM watch_evidence WHERE source_id = ? AND external_id = ? AND observed_at <= ? ORDER BY observed_at DESC, id DESC LIMIT 1');
  const emit = (row, observation, level, title, message, classification, keys = [row.external_id], { kind = KIND.OFFICIAL_NOTICE, keySource = row.source_id, occurredAt = new Date(row.observed_at).toISOString() } = {}) => {
    summary.matched[row.source_id] += 1;
    events.push(buildCbrnEvent({ kind, level, occurredAt, title, message, source: row.source_id, publicUrl: observation.url, keyParts: [keySource, ...keys].map(encodeURIComponent), payload: { source_id: row.source_id, external_id: row.external_id, source_url: observation.url ?? null, ...classification } }));
  };
  for (const source of SOURCES) {
    summary.heads[source] = watch.prepare('SELECT count(*) AS n FROM watch_items WHERE source_id = ?').get(source).n;
    summary.scanned[source] = 0;
    summary.matched[source] = 0;
    if (!summary.heads[source]) summary.unavailable.push(source);
    const rows = watch.prepare('SELECT e.* FROM watch_items i JOIN watch_evidence e ON e.id = i.evidence_id WHERE i.source_id = ? AND e.observed_at >= ? AND e.observed_at <= ? ORDER BY e.observed_at, e.id').all(source, since, now);
    for (const row of rows) {
      summary.scanned[source] += 1;
      let o;
      try { o = JSON.parse(row.observation); } catch { summary.invalid += 1; continue; }
      if (!o || typeof o !== 'object') { summary.invalid += 1; continue; }
      if (o.status === 'cancelled') continue;
      const d = o.data || {};
      if (source === 'nws-civil-alerts') {
        if (!['Nuclear Power Plant Warning', 'Radiological Hazard Warning', 'Hazardous Materials Warning'].includes(d.event) || d.actual !== true || d.test === true) continue;
        if (d.expiresAt != null && !(Date.parse(d.expiresAt) > now)) continue;
        if (!d.messageId || !d.messageType) { summary.invalid += 1; continue; }
        const instruction = typeof d.instruction === 'string' && d.instruction.trim() ? d.instruction : d.description || o.summary || '';
        emit(row, o, 5, o.title || d.event, `Headline: ${d.headline ?? o.title ?? 'Not supplied'}\nIssuing authority: ${d.senderName ?? 'Not supplied'}\nAffected area: ${d.area ?? 'Not supplied'}\nUTC expiry: ${d.expiresAt == null ? 'Not supplied' : new Date(d.expiresAt).toISOString()}\nAuthority instruction / description:\n${instruction}`, { event: d.event, actual: d.actual, test: d.test ?? null, messageId: d.messageId, messageType: d.messageType, headline: d.headline ?? o.title, senderName: d.senderName ?? null, area: d.area ?? null, expiresAt: d.expiresAt ?? null, instruction, description: d.description ?? null }, [d.messageId, d.messageType]);
      } else if (source === 'nrc-events') {
        const emergencyClass = d.emergencyClass ?? null;
        const level = /^(alert|site area emergency|general emergency)$/i.test(String(emergencyClass ?? '').trim()) ? 4 : 1;
        emit(row, o, level, o.title || 'NRC event notification', `NRC event notification for ${d.facility ?? 'facility not supplied'}, ${d.state ?? 'state not supplied'}. Classification (verbatim): ${emergencyClass ?? 'not supplied'}. Source: nrc-events, licensee reports, US-only.`, { emergencyClass, facility: d.facility ?? null, state: d.state ?? null, eventNumber: row.external_id }, [row.external_id]);
      } else if (source === 'nrc-reactor-status') {
        if (typeof d.unit !== 'string' || typeof d.powerPercent !== 'number' || d.powerPercent < 0 || d.powerPercent > 5) continue;
        const previous = prior.get(source, row.external_id, row.observed_at - 1800000);
        if (!previous) continue;
        let p;
        try { p = JSON.parse(previous.observation); } catch { summary.invalid += 1; continue; }
        if (p?.status === 'cancelled' || typeof p?.data?.powerPercent !== 'number' || p.data.powerPercent < 50 || p.data.powerPercent > 100) continue;
        const site = d.unit.replace(/\s*(?:unit\s*)?[-#]?\s*\d+\s*$/i, '').trim();
        trips.push({ row, o, d, site, previous: p.data.powerPercent });
      } else if (source === 'faa-tfr') {
        if (!Number.isFinite(d.centroidLat) || !Number.isFinite(d.centroidLon) || Math.abs(d.centroidLat) > 90 || Math.abs(d.centroidLon) > 180) continue;
        if (watch.prepare('SELECT 1 FROM watch_evidence WHERE source_id = ? AND external_id = ? AND observed_at < ? LIMIT 1').get(source, row.external_id, row.observed_at)) continue;
        for (const region of regions.filter((r) => r.enabled && r.role === 'target')) {
          const distance = haversineKm(region.lat, region.lon, d.centroidLat, d.centroidLon);
          if (distance > 80) continue;
          emit(row, o, 1, `New airspace restriction near ${region.name}`, `First observed FAA TFR ${distance.toFixed(1)} km from ${region.name}; threshold: distance <= 80 km.\nFAA title (verbatim): ${d.title ?? o.title ?? 'Not supplied'}\nState (verbatim): ${d.state ?? 'Not supplied'}\nModification time (verbatim; source timezone): ${d.lastModified ?? 'Not supplied'}`, { title: d.title ?? o.title ?? null, state: d.state ?? null, lastModified: d.lastModified ?? null, region: region.id, centroidLat: d.centroidLat, centroidLon: d.centroidLon, distance_km: distance }, [row.external_id, region.id]);
          states.push({ series: `fusion:${region.id}`, method: 'window', state: { region: region.id, timestamp: new Date(row.observed_at).toISOString(), occurred_at: new Date(row.observed_at).toISOString(), kind: KIND.OFFICIAL_NOTICE, level: 1, source_id: source, lat: d.centroidLat, lon: d.centroidLon } });
        }
      } else if (source === 'usgs-significant' || source === 'usgs-relevant') {
        const [lon, lat, depthKm] = Array.isArray(d.coordinates) ? d.coordinates : [];
        const occurredMs = Date.parse(o.occurredAt);
        if (!Number.isFinite(occurredMs) || now - occurredMs > SEISMIC_MAX_AGE_MS) continue;
        const verdict = assessSeismicEvent({ classification: d.classification, magnitude: d.magnitude, lat, lon, depthKm });
        if (!verdict) continue;
        const magnitude = `M${Number(d.magnitude).toFixed(1)}`;
        const where = verdict.site ? `${verdict.distanceKm.toFixed(0)} km from the ${verdict.site.name} (${verdict.site.country})` : d.place || 'location as catalogued';
        const at = `${new Date(occurredMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
        const depthText = Number.isFinite(depthKm) ? `${depthKm} km` : 'not supplied';
        const limits = 'A seismic location is not confirmation of a nuclear test, and an atmospheric burst would not appear here.';
        let title;
        let message;
        if (verdict.rule === 'agency_classified_nuclear') {
          title = `USGS classifies a ${magnitude} seismic event as a nuclear explosion${verdict.site ? `, ${where}` : ''}`;
          message = `USGS catalogued a ${magnitude} event at ${at}, ${d.place || 'place not supplied'}, depth ${depthText}, classification "nuclear explosion", review status ${d.reviewStatus || 'not supplied'}. The agency's own classification is the strongest open-source seismic evidence there is. ${limits}`;
        } else if (verdict.rule === 'agency_classified_explosion') {
          title = `USGS classifies a ${magnitude} seismic event as an explosion: ${d.place || 'place not supplied'}`;
          message = `USGS catalogued a ${magnitude} event at ${at}, ${d.place || 'place not supplied'}, as an explosion, not an earthquake, away from any known nuclear test site. Explosions this large are rare: none of M4 or more was catalogued worldwide in the year to September 2026. ${limits}`;
        } else {
          const depthClause = verdict.depth === 'shallow'
            ? `depth ${depthText}, within ${SHALLOW_KM} km of the surface as every catalogued nuclear test has been. Since 2000 one natural earthquake of this size has been catalogued this shallow within 50 km of any known test site, and it was induced by the 2017 test.`
            : verdict.depth === 'unconstrained'
              ? `depth not yet determined (USGS placeholder ${depthText}). Natural earthquakes of this size occur within 50 km of a known test site about once a year; a determined depth will raise or clear this.`
              : `depth ${depthText}, well below any test depth, so most likely a natural earthquake.`;
          title = verdict.depth === 'shallow' ? `Shallow ${magnitude} seismic event ${where}` : `${magnitude} seismic event ${where}`;
          message = `USGS located a ${magnitude} event at ${at}, ${where}, ${depthClause} USGS classification: ${d.classification}; review status ${d.reviewStatus || 'not supplied'}. ${limits}`;
        }
        emit(row, o, verdict.level, title, message, { rule: verdict.rule, magnitude: d.magnitude, depth_km: Number.isFinite(depthKm) ? depthKm : null, depth: verdict.depth, classification: d.classification, review_status: d.reviewStatus ?? null, site: verdict.site?.id ?? null, distance_km: verdict.distanceKm == null ? null : +verdict.distanceKm.toFixed(1) }, [row.external_id], { kind: KIND.SEISMIC_EVENT, keySource: 'usgs', occurredAt: new Date(occurredMs).toISOString() });
      } else if (source === 'who-outbreaks' || source === 'ecdc-threats') {
        const matched = agents.filter(([, re]) => re.test(String(o.title || '').normalize('NFKC'))).map(([term]) => term);
        if (!matched.length) continue;
        const authority = source === 'who-outbreaks' ? 'the World Health Organization' : 'the European Centre for Disease Prevention and Control';
        // A published outbreak report is a report, not one of our detections.
        // The public tier is reserved for measurements that leave their own
        // distribution and for authorities' own protective instructions; an
        // authority's report stays on the operator surface, where its arrival
        // is useful context and its push is not.
        emit(row, o, 1, o.title || 'CBRN-relevant outbreak report', `${authority} outbreak report; title matches: ${matched.join(', ')}.`, { agents: matched, publishedAt: o.publishedAt ?? null, authority });
      } else {
        // Aggregate and agency feeds are collected for context, but emitting an
        // event for every item would flood the operator surface with routine
        // news. Only a title that names a consequential incident qualifies, and
        // even then this never leaves the operator surface on its own.
        const text = String(o.title || '').normalize('NFKC');
        const incident = /\b(incident|emergency|release|leak|spill|fire|explosion|attack|strike|shelling|shelled|damage|evacuat\w*|alert|contamination|radiation levels?|power (?:loss|cut)|shutdown|scram|safeguards)\b/iu.test(text);
        const agentHit = agents.filter(([, re]) => re.test(text)).map(([term]) => term);
        if (!incident && !agentHit.length) continue;
        emit(row, o, 1, o.title || source, `${o.title || 'Untitled item'}. Source: ${source}, ${source === 'healthmap-alerts' ? 'aggregate disease reports' : 'agency news'}.`, { observation_kind: o.kind ?? null, agents: agentHit });
      }
    }
  }
  for (const trip of trips) {
    const nearby = trips.filter((other) => other.site === trip.site && Math.abs(other.row.observed_at - trip.row.observed_at) <= 3600000);
    // A rolling one-hour interval, not a two-hour radius, must contain all units.
    const grouped = nearby.some((start) => new Set(nearby.filter((other) => other.row.observed_at >= start.row.observed_at && other.row.observed_at <= start.row.observed_at + 3600000).map((other) => other.d.unit)).size >= 3);
    emit(trip.row, trip.o, grouped ? 3 : 1, `Reactor power drop: ${trip.d.unit}`, `NRC reports ${trip.d.unit}: ${trip.previous}% -> ${trip.d.powerPercent}% power; previous observation >= 30 minutes earlier.${grouped ? ' >= 3 units at this site dropped within 1 hour.' : ''} Threshold: previous power >= 50%, current power <= 5%.`, { unit: trip.d.unit, site: trip.site, powerPercent: trip.d.powerPercent, previousPowerPercent: trip.previous, multiple_units: grouped });
  }
  summary.events = events.length;
  return { summary, events, states };
}

function saveEvents(db, result) {
  db.transaction(() => {
    const lookup = db.prepare('SELECT severity FROM alert_events WHERE event_key = ?');
    for (const event of result.events) {
      const existing = lookup.get(event.eventKey);
      if (existing && RANK[existing.severity] > RANK[event.severity]) continue;
      const saved = insertCbrnEvent(db, event);
      if (saved.inserted) result.summary.events_written += 1;
      if (saved.escalated) result.summary.events_escalated += 1;
    }
  })();
}

function main() {
  const settings = options(process.argv.slice(2));
  const watch = new Database(settings.watchDb, { readonly: true, fileMustExist: true });
  let db;
  let eventsDb;
  try {
    const result = detect(watch, settings);
    if (settings.dryRun) {
      for (const event of result.events) console.log(JSON.stringify(event));
    } else {
      db = openCbrnDb({ dbPath: settings.cbrnDb });
      eventsDb = new Database(settings.eventsDb, { fileMustExist: true });
      saveEvents(eventsDb, result);
      db.transaction(() => { for (const entry of result.states) writeAlarmState(db, entry.series, entry.method, entry.state); })();
    }
    console.log(JSON.stringify(result.summary));
  } finally { watch.close(); db?.close(); eventsDb?.close(); }
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { options, matcher, detect, saveEvents };
