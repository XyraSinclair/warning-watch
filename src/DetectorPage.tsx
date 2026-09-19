import { useEffect, useState } from 'react';
import './detector.css';

type Alert = { kind: string; severity: string; cohort: string; occurredAt: string; title: string; message: string };
type Network = { source: string; stations: number; newestReading: string | null; ageMinutes: number | null };

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
};

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
        </p>
      </header>

      {error && <p className="err">Status unavailable: {error}</p>}

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
        <h2>Instruments</h2>
        <table>
          <tbody>
            <tr>
              <th>Gamma dose rate</th>
              <td>{num.format(radiation?.stationsTotal ?? 0)} stations</td>
              <td>{num.format(radiation?.reporting ?? 0)} networks reporting</td>
              <td>last reading {ago(status?.radiation.networks?.[0]?.newestReading ?? null)}</td>
            </tr>
            <tr>
              <th>Aircraft over CBRN sites</th>
              <td>{num.format(status?.aircraft.regions ?? 0)} regions</td>
              <td>5-minute samples</td>
              <td>last sample {ago(status?.aircraft.newestSample ?? null)}</td>
            </tr>
            <tr>
              <th>Business-jet movements</th>
              <td>{num.format(status?.aviation.aircraft.tracked ?? 0)} airframes</td>
              <td>one fix per 30 minutes</td>
              <td>last fix {ago(status?.aviation.aircraft.newestFix ?? null)}</td>
            </tr>
            <tr>
              <th>Business-jet departures</th>
              <td>{num.format(status?.aviation.departures.records ?? 0)} records</td>
              <td>{num.format(status?.aviation.departures.days ?? 0)} days</td>
              <td>last departure {ago(status?.aviation.departures.newest ?? null)}</td>
            </tr>
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
            coherence: 3 stations within 50 km for elevated, 5 for high, 15 or any station at 10 µSv/h for critical.
          </dd>
          <dt>Air traffic over a region</dt>
          <dd>
            Per region, same-hour baseline over 21 days, minimum 10 samples. Void at 25 % of the median, or a score of
            −5. Elevated when a void holds at 10 % of the median for three consecutive samples. Both control regions
            must report, or the sample is discarded as a feed failure.
          </dd>
          <dt>Aircraft turnarounds</dt>
          <dd>
            A bearing change of 120° or more at 10,000 ft or above, with both legs at least 20 nm, so manoeuvring near
            an airfield cannot qualify. A cluster needs 3 aircraft within 200 km of each other inside 60 minutes
            against the same hour on the previous 21 days; 6 reaches high. One aircraft never leaves the operator
            surface.
          </dd>
          <dt>Departure concentration</dt>
          <dd>
            6 departures within 60 km of each other inside 60 minutes, against the same hour on the previous 21 days.
          </dd>
          <dt>Turnaround volume</dt>
          <dd>
            Takeoff rate scored against a seasonal baseline of the same weekday class and half-hour slot, with a
            sustained-shift accumulator. A 3× exodus reaches high within an hour and critical within two.
          </dd>
          <dt>Notices</dt>
          <dd>
            An NRC event notification at emergency class Alert, Site Area Emergency or General Emergency reports as
            high; anything else as operator-only. An actual CAP warning of type Nuclear Power Plant, Radiological
            Hazard or Hazardous Materials reports as critical, carrying the issuing authority's own text verbatim.
            Agency reporting — outbreak bulletins, IAEA news, aggregate disease feeds — is collected and stays on the
            operator surface. A published report is not one of our detections.
          </dd>
          <dt>Vocabulary</dt>
          <dd>
            Matched CBRN event words per place per hour against a 14-day same-hour baseline, minimum 10 samples.
            Elevated at 6 matched terms across 3 posts; high at 25 across 8. Never critical on its own.
          </dd>
        </dl>
        <p>
          Two instruments agreeing on the same place and time is a third rule: the top severity requires agreement
          between independent instruments, and a single instrument is reported one tier lower.
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
              <td className={(status?.aviation.departures.days ?? 0) >= 21 ? 'ok' : 'warm'}>
                {(status?.aviation.departures.days ?? 0) >= 21 ? 'armed' : 'warming'}
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

      <section>
        <h2>Subscribe</h2>
        <p>
          Push: in the <a href="https://ntfy.sh/">ntfy</a> app, subscribe to{' '}
          <code id="topic">https://ntfy.warning.watch/warning-watch-alerts</code>. Feed:{' '}
          <a href="/rss.xml">/rss.xml</a>. Alerts publish to both at elevated and above.
        </p>
      </section>
    </main>
  );
}
