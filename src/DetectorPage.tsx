import { useEffect, useState } from 'react';
import './detector.css';
import { Channels, SubscribePanel } from './Subscribe';

type Alert = { kind: string; severity: string; cohort: string; occurredAt: string; title: string; message: string };
type Cohort = { key: string; label: string; roster: number; airborne: number | null; sampledAt: string | null; samples: number };

type Status = {
  generatedAt: string;
  alerts: Alert[];
  aviation: {
    aircraft: { tracked: number; newestFix: string | null; ageMinutes: number | null };
    behaviour: { turnarounds24h: number; hoursRecorded: number; hourlySamples: number; armed: boolean };
    departures: { records: number; days: number; newest: string | null; ageMinutes: number | null };
  };
  cohorts: Cohort[];
  archive: { lastReadAt: string | null; ageMinutes: number | null; lastAttemptAt: string | null; error: string | null };
  channels: Channels;
};

// The aircraft cohorts are sampled from the ADS-B Exchange archive every half hour. With
// no whole read in 75 minutes (the data-age bound) they are not watching, and the page
// says so and why: the archive's last answer, as the poller recorded it.
function archiveNote(archive: Status['archive']): string {
  return (
    `Aircraft: no sample since ${utc(archive.lastReadAt)}; the ADS-B Exchange archive has refused or not answered ` +
    `our reads since then, the last ${ago(archive.lastAttemptAt)}: ${archive.error}. ` +
    'Without samples the aircraft cohorts raise no alerts until it answers again.'
  );
}
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
  const older = alerts.filter((alert) => !recent.includes(alert));
  const behaviour = status?.aviation.behaviour;

  return (
    <main className="detector">
      <header>
        <h1>warning<span>.watch</span></h1>
        <p className="purpose">
          The people with the most to lose and the best information move first, and they move by air. We count
          business jets and military aircraft in the air every half hour and raise an alert when the count leaves
          its own baseline by more than a fixed threshold. Alerts carry the measurement and its numbers. Every
          threshold is stated below.
        </p>
      </header>

      {error && <p className="err">Status unavailable: {error}</p>}

      <section>
        <h2>Alerts</h2>
        <h3 className="sub">Last seven days</h3>
        {!status ? (
          <p className="quiet">{error ? 'The alert record could not be loaded, so this page cannot say whether an alert is open.' : 'Loading the alert record.'}</p>
        ) : recent.length === 0 ? (
          <p className="quiet">No alert has been raised.</p>
        ) : (
          <ol className="alerts">
            {recent.map((alert) => (
              <li key={`${alert.kind}-${alert.occurredAt}-${alert.title}`} className={`alert sev-${alert.severity}`}>
                <div className="alert-head">
                  <span className={`sev ${alert.severity}`}>{alert.severity}</span>
                  <time dateTime={alert.occurredAt}>{utc(alert.occurredAt)}</time>
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
                  <time dateTime={alert.occurredAt}>{utc(alert.occurredAt)}</time>
                  <span>{alert.title}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <SubscribePanel channels={status?.channels ?? null} />


      <section>
        <h2>Flight tracking</h2>
        <p>
          We read the whole sky. Every half hour, every aircraft broadcasting a position anywhere on Earth is matched
          against a roster of {num.format(status?.cohorts?.[0]?.roster ?? 0)} business jets and{' '}
          {num.format(status?.cohorts?.[1]?.roster ?? 0)} military airframes, and aircraft broadcasting an address no
          registry issued are counted beside them. {num.format(status?.aviation.departures.records ?? 0)} departures over{' '}
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
          </tbody>
        </table>
        {status?.archive?.error && status.archive.ageMinutes != null && status.archive.ageMinutes > 75 && (
          <p className="fine">{archiveNote(status.archive)}</p>
        )}
        <p className="fine">
          Positions come from ADS-B Exchange, which does not honour requests to hide an aircraft. We publish counts and
          alerts, never one aircraft's movements.
        </p>
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
          <dt>Aircraft turnarounds</dt>
          <dd>
            A bearing change of 120° or more at 10,000 ft or above, with both legs at least 20 nm, so manoeuvring near
            an airfield cannot qualify. A cluster needs 3 aircraft (5 in the military cohort) within
            200 km of each other inside 60 minutes, and three times the median for the same hour on the previous 21
            days, minimum 10 samples. Twice the floor, 6 or 10, reaches high. One aircraft alone notifies only the
            operator.
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
            caught by a running tally of how far the number airborne stays above normal: three times normal reaches
            high within an hour and critical within two.
          </dd>
        </dl>
        <p>
          Agreement is its own rule. The three aircraft cohorts are three instruments: a critical from one of them
          is reported as high, and says so, unless a second cohort is at elevated or above within 90 minutes.
        </p>
        <p>
          Takeoff volume sets its thresholds from a false-alarm budget: elevated at most twelve times a year, high
          four, critical one. The other rules use fixed thresholds, checked against the measured record given with
          each rule where we have one. An instrument that stops reporting pages the operator. A quiet page means nothing crossed a threshold. It
          never means nothing happened.
        </p>
        <p>
          Every rule on this page is code you can read:{' '}
          <a href={`${SOURCE}/scripts/detect_alert_events.js`}>takeoff volume</a>,{' '}
          <a href={`${SOURCE}/scripts/detect_flight_behaviour.js`}>turnarounds and departures</a>.
        </p>
      </section>

      <section>
        <h2>Baseline state</h2>
        <table>
          <tbody>
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
          </tbody>
        </table>
      </section>

    </main>
  );
}
