import { useEffect, useState } from 'react';
import './detector.css';
import { Channels, SubscribePanel } from './Subscribe';

type Alert = { kind: string; severity: string; cohort: string; occurredAt: string; title: string; message: string };
type Network = { source: string; stations: number; newestReading: string | null; ageMinutes: number | null };
type Cohort = { key: string; label: string; roster: number; airborne: number | null; sampledAt: string | null; samples: number };

type Status = {
  generatedAt: string;
  alerts: Alert[];
  radiation: { networks: Network[]; reporting: number; stationsArmed: number; stationsTotal: number };
  aircraft: { regions: number; newestSample: string | null; ageMinutes: number | null };
  aviation: {
    aircraft: { tracked: number; newestFix: string | null; ageMinutes: number | null };
    behaviour: { turnarounds24h: number; hoursRecorded: number; hourlySamples: number; armed: boolean };
    departures: { records: number; days: number; newest: string | null; ageMinutes: number | null };
  };
  cohorts: Cohort[];
  sources: { id: string; lastSuccessAt: string | null; health: 'live' | 'stale' | 'never' }[];
  channels: Channels;
};

const SOURCE_NAMES: Record<string, string> = {
  'nws-civil-alerts': 'NWS CAP warnings',
  'nrc-events': 'NRC event notifications',
  'nrc-reactor-status': 'NRC reactor status',
  'faa-tfr': 'FAA flight restrictions',
  'usgs-significant': 'USGS significant events',
  'usgs-relevant': 'USGS relevant events',
  'bluesky-posts': 'Bluesky posts',
  'gdelt-reporting': 'GDELT reporting',
};

// The sentence a rule carries when its inputs are not answering.
function inputState(sources: Status['sources'] | undefined, ids: string[]): string {
  const rows = (sources ?? []).filter((source) => ids.includes(source.id));
  if (rows.length === 0 || rows.some((source) => source.health === 'live')) return '';
  const never = rows.every((source) => source.health === 'never');
  return never
    ? ' This rule has no input: its source has never answered us.'
    : ' This rule has no live input: its sources stopped answering ' +
        rows.map((source) => `${SOURCE_NAMES[source.id] ?? source.id} ${ago(source.lastSuccessAt)}`).join(', ') +
        '.';
}

const NETWORK_NAMES: Record<string, string> = {
  de: 'Germany, BfS national network',
  eurdep: 'Europe, EURDEP exchange',
  radnet: 'United States, EPA RadNet',
};
const SOURCE = 'https://github.com/XyraSinclair/warning-watch/blob/main';

const POLL_MS = 60_000;

function ago(value: string | null): string {
  if (!value) return 'never';
  const ms = Date.now() - Date.parse(value);
  if (!Number.isFinite(ms)) return 'unknown';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function utc(value: string | null): string {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? `${new Date(parsed).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—';
}

const num = new Intl.NumberFormat('en-US');

export default function DetectorPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch('/api/status', { signal: controller.signal, headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`status ${response.status}`);
        const payload = (await response.json()) as Status;
        if (!cancelled) {
          setStatus(payload);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled && (caught as Error).name !== 'AbortError') setError((caught as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  const alerts = status?.alerts ?? [];
  const RECENT_MS = 7 * 86400000;
  const recent = alerts.filter((alert) => Date.now() - Date.parse(alert.occurredAt) <= RECENT_MS);
  const older = alerts.slice(recent.length);
  const behaviour = status?.aviation.behaviour;
  const radiation = status?.radiation;

  return (
    <main className="detector">
      <header>
        <h1>warning<span>.watch</span></h1>
        <p className="purpose">
          We sample public data continuously and raise an alert when a measurement leaves its own baseline by more
          than a fixed threshold. Alerts carry the measurement and its numbers. Every threshold is stated below.
          Our gamma networks cover Germany, the EURDEP exchange and the United States: an atmospheric burst anywhere
          else is invisible to these instruments until an authority reports it.
        </p>
      </header>

      {error && <p className="err">Status unavailable: {error}</p>}

      <SubscribePanel channels={status?.channels ?? null} />

      <section>
        <h2>Alerts</h2>
        <h3 className="sub">Last seven days</h3>
        {recent.length === 0 ? (
          <p className="quiet">No alert has been raised.</p>
        ) : (
          <ol className="alerts">
            {recent.map((alert) => (
              <li key={`${alert.kind}-${alert.occurredAt}-${alert.title}`} className={`alert sev-${alert.severity}`}>
                <div className="alert-head">
                  <span className={`sev ${alert.severity}`}>{alert.severity}</span>
                  <time>{utc(alert.occurredAt)}</time>
                  <span className="ago">{ago(alert.occurredAt)}</span>
                </div>
                <h3>{alert.title}</h3>
                <p>{alert.message}</p>
              </li>
            ))}
          </ol>
        )}
        {older.length > 0 && (
          <>
            <h3 className="sub">Earlier</h3>
            <ul className="history">
              {older.map((alert) => (
                <li key={`${alert.kind}-${alert.occurredAt}-${alert.title}`}>
                  <span className={`sev ${alert.severity}`}>{alert.severity}</span>
                  <time>{utc(alert.occurredAt)}</time>
                  <span>{alert.title}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <h2>Flight tracking</h2>
        <p>
          We read the whole sky. Every half hour, every aircraft broadcasting a position anywhere on Earth is matched
          against a roster of {num.format(status?.cohorts?.[0]?.roster ?? 0)} business jets and{' '}
          {num.format(status?.cohorts?.[1]?.roster ?? 0)} military airframes, and aircraft broadcasting an address no
          registry issued are counted beside them. Over {num.format(status?.aircraft.regions ?? 0)} watched regions, nuclear
          plants and fuel-cycle sites, chemical complexes, two capitals and two control regions, we sample the airspace
          every five minutes. The people with the most to lose and the best information
          move first, and they move by air: {num.format(status?.aviation.departures.records ?? 0)} departures over{' '}
          {num.format(status?.aviation.departures.days ?? 0)} days are the baseline every new half hour is scored
          against.
        </p>
        <table>
          <tbody>
            {(status?.cohorts ?? []).map((cohort) => (
              <tr key={cohort.key}>
                <th>{cohort.label}</th>
                <td>{cohort.airborne == null ? '—' : `${num.format(cohort.airborne)} airborne`}</td>
                <td>{cohort.roster ? `of ${num.format(cohort.roster)} on the roster` : 'counted, not named'}</td>
                <td>sampled {ago(cohort.sampledAt)}</td>
              </tr>
            ))}
            <tr>
              <th>Departures</th>
              <td>{num.format(status?.aviation.departures.records ?? 0)} recorded</td>
              <td>{num.format(status?.aviation.behaviour.turnarounds24h ?? 0)} turnarounds in 24 hours</td>
              <td>last departure {ago(status?.aviation.departures.newest ?? null)}</td>
            </tr>
            <tr>
              <th>Airspace over CBRN sites</th>
              <td>{num.format(status?.aircraft.regions ?? 0)} regions</td>
              <td>5-minute samples</td>
              <td>sampled {ago(status?.aircraft.newestSample ?? null)}</td>
            </tr>
          </tbody>
        </table>
        <p className="fine">
          Positions come from ADS-B Exchange, which does not honour requests to hide an aircraft. We publish counts and
          alerts, never one aircraft's movements.
        </p>
      </section>

      <section>
        <h2>Radiation</h2>
        <table>
          <tbody>
            {(radiation?.networks ?? []).map((network) => (
              <tr key={network.source}>
                <th>{NETWORK_NAMES[network.source] ?? network.source}</th>
                <td>{num.format(network.stations)} gamma monitors</td>
                <td>hourly</td>
                <td>last reading {ago(network.newestReading)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>How detection works</h2>
        <p>
          Each series keeps a robust baseline of its own past: the median value and the median absolute deviation as
          the scale, both recomputed as data arrives. A new value is scored as its distance from the median in units
          of that scale. A score alone never alerts — every threshold also requires an absolute magnitude, because a
          quiet sensor can score far from its median while measuring nothing. No baseline, no alert.
        </p>
        <dl className="rules">
          <dt>Gamma dose rate</dt>
          <dd>
            Per station, 30-day baseline, minimum 48 hourly samples. A station departs at 3× its median and +0.5
            µSv/h, or at 5 µSv/h outright. A single station never exceeds the operator surface. The public tiers need
            coherence: every station in the group at a robust score of 5 or more, under at least two station names,
            with 3 stations within 50 km for elevated, 5 for high, 15 or any station at 10 µSv/h for critical.
            EPA RadNet has one monitor per city, so it asks agreement of time instead of space: one departing hour is
            elevated, a second consecutive hour or a second monitor is high, 10 µSv/h while confirmed is critical. In
            1.59 million monitor-hours since January 2025 no RadNet monitor met the station threshold once; the highest
            hour was 0.32 µSv/h. EPA publishes only hours it has approved, so silence from RadNet is not an all-clear.
          </dd>
          <dt>Underground detonation</dt>
          <dd>
            Every USGS seismic event. One the agency types as a nuclear explosion is critical. Within the listed radius
            of a known test site, magnitude 3.5 or more is high when it is typed an explosion or is shallower than
            5 km; when USGS could not constrain the depth it is high at a seismically quiet site and elevated at an
            active one. Anywhere else, an event typed an explosion at magnitude 4 or more is elevated. The record: all
            six North Korean tests are catalogued this way. Over 26.7 years natural earthquakes raised this rule nine
            times, about one every three years: eight elevated, and one high, the aftershock the 2017 test itself
            induced. This rule cannot see an atmospheric burst or a test at an unlisted site, and it is verification, not
            warning: the catalogue publishes tens of minutes after the event.
          </dd>
          <dt>Air traffic over a region</dt>
          <dd>
            Per region, same-hour baseline over 21 days, minimum 10 samples and a median of at least 15 aircraft, so
            a sky that is normally empty cannot go void. Void at 25 % of the median, or a score of
            −5. Elevated when a void holds at 10 % of the median for three consecutive samples. Both control regions
            must report, or the sample is discarded as a feed failure.
          </dd>
          <dt>Aircraft turnarounds</dt>
          <dd>
            A bearing change of 120° or more at 10,000 ft or above, with both legs at least 20 nm, so manoeuvring near
            an airfield cannot qualify. A cluster needs 3 aircraft (5 in the military cohort) within
            200 km of each other inside 60 minutes, and three times the median for the same hour on the previous 21
            days, minimum 10 samples. Twice the floor, 6 or 10, reaches high. One aircraft never leaves the operator
            surface.
          </dd>
          <dt>Departure concentration</dt>
          <dd>
            6 departures within 60 km of each other inside 60 minutes, and three times the median for the same
            footprint at the same hour over at least 10 covered days. Twice that threshold reaches high.
          </dd>
          <dt>Takeoff volume</dt>
          <dd>
            Takeoffs per half-hour, scored as a count against the same weekday class and half-hour over
            28 days. Elevated needs three times the expected count and a count that chance alone produces in fewer
            than 1 half-hour in 1,460 — twelve a year. High is 1 in 4,380; critical, 1 in 17,520. A cohort's public
            tiers open once its scored record holds 1,460 half-hours; the business-jet record does, the military
            record reaches it about 20 October 2026. A slower exodus is
            carried by a sustained-shift accumulator on the number airborne: 3× reaches high within an hour and
            critical within two.
          </dd>
          <dt>Notices</dt>
          <dd>
            An actual CAP warning of type Nuclear Power Plant or Radiological Hazard reports as critical, and a
            Hazardous Materials warning as high, carrying the issuing authority's own text verbatim. An NRC event
            notification at emergency class Alert, Site Area Emergency or General Emergency reports as high; anything
            else as operator-only.{inputState(status?.sources, ['nrc-events', 'nrc-reactor-status'])}{' '}
            Agency reporting — outbreak bulletins, IAEA news, aggregate disease feeds — is collected and stays on the
            operator surface. A published report is not one of our detections.
          </dd>
          <dt>Vocabulary</dt>
          <dd>
            Matched CBRN event words per place per hour against a 14-day same-hour baseline, minimum 10 samples.
            Elevated at 8 matched terms across 3 posts and three times the median; high at 25 across 8. Never
            critical on its own.{inputState(status?.sources, ['bluesky-posts', 'gdelt-reporting'])}
          </dd>
        </dl>
        <p>
          Agreement is its own rule. The three aircraft cohorts are three instruments: a critical from one of them
          is reported as high, and says so, unless a second cohort is at elevated or above within 90 minutes.
          Three things reach critical alone, because each is already a confirmation: radiation at 10 µSv/h once
          stations or consecutive hours agree, a seismic event USGS types as a nuclear explosion, and an authority's own CAP warning.
        </p>
        <p>
          Each tier has a false-alarm budget, and thresholds are set from the measured record to meet it: elevated at
          most twelve times a year, high four, critical one. An instrument that stops reporting pages the operator,
          and the table below shows which inputs are answering. A quiet page means nothing crossed a threshold. It
          never means nothing happened.
        </p>
        <p>
          Every rule on this page is code you can read:{' '}
          <a href={`${SOURCE}/scripts/detect_cbrn_radiation.js`}>radiation</a>,{' '}
          <a href={`${SOURCE}/server/detonation-rule.js`}>detonation</a>,{' '}
          <a href={`${SOURCE}/scripts/detect_alert_events.js`}>aviation</a>,{' '}
          <a href={`${SOURCE}/CBRN-WATCH.md`}>the full method and its limits</a>.
        </p>
      </section>

      <section>
        <h2>Baseline state</h2>
        <table>
          <tbody>
            <tr>
              <th>Gamma stations with 48 hourly samples</th>
              <td>{num.format(radiation?.stationsArmed ?? 0)} of {num.format(radiation?.stationsTotal ?? 0)}</td>
              <td className={radiation && radiation.stationsArmed > 0 ? 'ok' : 'warm'}>
                {radiation && radiation.stationsArmed > 0 ? 'armed' : 'warming'}
              </td>
            </tr>
            <tr>
              <th>Turnaround cluster baseline</th>
              <td>{num.format(behaviour?.hourlySamples ?? 0)} of 10 same-hour samples</td>
              <td className={behaviour?.armed ? 'ok' : 'warm'}>{behaviour?.armed ? 'armed' : 'warming'}</td>
            </tr>
            <tr>
              <th>Departure cluster baseline</th>
              <td>{num.format(status?.aviation.departures.days ?? 0)} days of departures</td>
              <td className={(status?.aviation.departures.days ?? 0) >= 10 ? 'ok' : 'warm'}>
                {(status?.aviation.departures.days ?? 0) >= 10 ? 'armed' : 'warming'}
              </td>
            </tr>
            <tr>
              <th>Turnarounds recorded</th>
              <td>{num.format(behaviour?.turnarounds24h ?? 0)} in the last 24 hours</td>
              <td>{num.format(behaviour?.hoursRecorded ?? 0)} hours recorded</td>
            </tr>
            {(status?.sources ?? []).map((source) => (
              <tr key={source.id}>
                <th>{SOURCE_NAMES[source.id] ?? source.id}</th>
                <td>{source.lastSuccessAt ? `last answered ${ago(source.lastSuccessAt)}` : 'has never answered'}</td>
                <td className={source.health === 'live' ? 'ok' : 'warm'}>{source.health}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

    </main>
  );
}
