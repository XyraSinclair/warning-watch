import { FormEvent, useEffect, useState } from 'react';

// Which channels the server can deliver on right now (from /api/status). The
// ntfy topic and the feed need no provider and are always open.
export type Channels = { email: boolean; sms: boolean; push: boolean };

const TOPIC_URL = 'https://ntfy.warning.watch/warning-watch-alerts';
const TOPIC_APP_URL = 'ntfy://ntfy.warning.watch/warning-watch-alerts';
const FEED_URL = 'https://warning.watch/rss.xml';

type Tab = 'ntfy' | 'email' | 'sms' | 'push' | 'feed';
type Note = { tone: 'ok' | 'err'; text: string; managePath?: string | null };

async function api(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, init);
  const json = (response.headers.get('content-type') ?? '').includes('json');
  const payload = (json ? await response.json() : { error: await response.text() }) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === 'string' && payload.error ? payload.error : `Request failed with HTTP ${response.status}`);
  return payload;
}

function post(path: string, body: unknown) {
  return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function Copy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

async function enableBrowserPush(): Promise<string> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    throw new Error('This browser cannot receive push notifications. The ntfy app can.');
  }
  if (Notification.permission === 'denied') throw new Error('Notifications are blocked for this site in your browser settings.');
  const { publicKey } = await api('/api/push/vapid-public-key', { cache: 'no-store' });
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notification permission was not granted.');
  const registration = await navigator.serviceWorker.register('/ews-service-worker.js');
  const padded = String(publicKey).replace(/-/g, '+').replace(/_/g, '/');
  const key = Uint8Array.from(window.atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  await post('/api/push/subscribe', { subscription: subscription.toJSON() });
  return 'This browser will now receive alerts.';
}

export function SubscribePanel({ channels }: { channels: Channels | null }) {
  const [tab, setTab] = useState<Tab>('ntfy');
  const [contact, setContact] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const tabs: [Tab, string][] = [
    ['ntfy', 'Phone push'],
    ...(channels?.email ? ([['email', 'Email']] as [Tab, string][]) : []),
    ...(channels?.sms ? ([['sms', 'Text']] as [Tab, string][]) : []),
    ...(channels?.push ? ([['push', 'This browser']] as [Tab, string][]) : []),
    ['feed', 'Feed'],
  ];

  function choose(next: Tab) {
    setTab(next);
    setContact('');
    setConsent(false);
    setNote(null);
  }

  async function run(work: () => Promise<Note>) {
    setBusy(true);
    setNote(null);
    try {
      setNote(await work());
    } catch (caught) {
      setNote({ tone: 'err', text: (caught as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = contact.trim();
    const sms = tab === 'sms';
    if (sms ? !/^\+[0-9][0-9\s().-]{6,}$/.test(value) : !/^\S+@\S+\.\S+$/.test(value)) {
      setNote({ tone: 'err', text: sms ? 'Enter the number with its country code, like +1 415 555 2671.' : 'Enter a valid email address.' });
      return;
    }
    void run(async () => {
      const payload = await post('/api/notifications/signup', sms ? { phone: value, smsConsent: true } : { email: value });
      const confirmations = Array.isArray(payload.confirmations) ? payload.confirmations : [];
      if (confirmations.some((entry) => entry?.sent === false)) {
        throw new Error('The confirmation could not be sent. Nothing is subscribed yet. Try again shortly.');
      }
      return {
        tone: 'ok',
        text: sms
          ? 'We sent a confirmation text. Open its link and alerts begin.'
          : 'We sent a confirmation email. Open its link and alerts begin.',
        managePath: typeof payload.managementPath === 'string' ? payload.managementPath : null,
      };
    });
  }

  return (
    <section className="subscribe" id="subscribe">
      <h2>Get the alert</h2>
      <p>
        One message when an instrument crosses its threshold, carrying the measurement and its numbers. Nothing else is
        ever sent. Choose how it reaches you.
      </p>
      <p>
        Keep your government's own warning switched on: it reaches you first for anything an authority has announced.
        This watches the instruments for what has not been announced yet, and an instrument can miss.
      </p>
      <div className="tabs" role="tablist">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => choose(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'ntfy' && (
        <div className="pane">
          <p>
            Fastest, and it asks for nothing about you. Install the free <a href="https://ntfy.sh/">ntfy</a> app, then
            subscribe to this topic:
          </p>
          <p className="copyrow">
            <code>{TOPIC_URL}</code>
            <Copy value={TOPIC_URL} />
          </p>
          <p>
            <a className="action" href={TOPIC_APP_URL}>Open in the ntfy app</a>{' '}
            <a href={TOPIC_URL}>or watch it in this browser</a>
          </p>
        </div>
      )}

      {(tab === 'email' || tab === 'sms') && (
        <form className="pane" onSubmit={submit} noValidate>
          <p className="copyrow">
            <input
              type={tab === 'sms' ? 'tel' : 'email'}
              autoComplete={tab === 'sms' ? 'tel' : 'email'}
              placeholder={tab === 'sms' ? '+1 415 555 2671' : 'you@example.com'}
              aria-label={tab === 'sms' ? 'Mobile number with country code' : 'Email address'}
              value={contact}
              onChange={(event) => setContact(event.currentTarget.value)}
            />
            <button className="action" type="submit" disabled={busy || (tab === 'sms' && !consent)}>
              {busy ? 'Sending…' : 'Send my confirmation'}
            </button>
          </p>
          {tab === 'sms' && (
            <label className="consent">
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.currentTarget.checked)} />
              <span>Send warning.watch alerts to this number by text. Message and data rates may apply; reply STOP to end.</span>
            </label>
          )}
          <p className="fine">
            Nothing is sent until you open the confirmation link. Your {tab === 'sms' ? 'number' : 'address'} is
            encrypted at rest and used for alerts only. Every message carries a link that ends them.
          </p>
        </form>
      )}

      {tab === 'push' && (
        <div className="pane">
          <p>Alerts as notifications from this browser on this device. No address, no account.</p>
          <p>
            <button className="action" type="button" disabled={busy} onClick={() => void run(async () => ({ tone: 'ok', text: await enableBrowserPush() }))}>
              {busy ? 'Enabling…' : 'Enable alerts in this browser'}
            </button>
          </p>
        </div>
      )}

      {tab === 'feed' && (
        <div className="pane">
          <p>The same alerts as an RSS feed, for a reader or a script.</p>
          <p className="copyrow">
            <code>{FEED_URL}</code>
            <Copy value={FEED_URL} />
          </p>
        </div>
      )}

      {note && (
        <p className={note.tone === 'ok' ? 'note ok' : 'note err'} role="status">
          {note.text} {note.managePath && <a href={note.managePath}>Manage this subscription</a>}
        </p>
      )}
    </section>
  );
}

type Subscriber = { id: string | number; status: string; email?: string | null; phone?: string | null; wantsEmail?: boolean; wantsSms?: boolean };

// The page behind the link in every email and text: change channels, or stop.
export function ManagePage() {
  const params = new URLSearchParams(window.location.search);
  const subscriberId = params.get('subscriber') || '';
  const token = params.get('token') || '';
  const [subscriber, setSubscriber] = useState<Subscriber | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(work: () => Promise<Record<string, unknown>>, done?: string) {
    setBusy(true);
    setNote(null);
    try {
      const payload = await work();
      if (!payload.subscriber || typeof payload.subscriber !== 'object') throw new Error('The server returned no subscription.');
      setSubscriber(payload.subscriber as Subscriber);
      if (done) setNote({ tone: 'ok', text: done });
    } catch (caught) {
      setNote({ tone: 'err', text: (caught as Error).message });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!subscriberId || !token) {
      setNote({ tone: 'err', text: 'This link is incomplete. Open the link from your latest alert or confirmation message.' });
      return;
    }
    void call(() => api(`/api/manage/subscriber?${new URLSearchParams({ subscriber: subscriberId, token })}`, { cache: 'no-store' }));
  }, [subscriberId, token]);

  const save = (wantsEmail: boolean, wantsSms: boolean, done: string) =>
    call(() => post('/api/manage/subscriber', { subscriber: subscriberId, token, action: 'save', wantsEmail, wantsSms }), done);

  return (
    <main className="detector">
      <header>
        <h1><a href="/">warning<span>.watch</span></a></h1>
        <p className="purpose">Your alert subscription.</p>
      </header>
      {note && <p className={note.tone === 'ok' ? 'note ok' : 'note err'} role="status">{note.text}</p>}
      {subscriber && (
        <section className="subscribe">
          {subscriber.email && (
            <label className="consent">
              <input type="checkbox" checked={Boolean(subscriber.wantsEmail)} disabled={busy} onChange={(event) => void save(event.currentTarget.checked, Boolean(subscriber.wantsSms), 'Saved.')} />
              <span>Email alerts to {subscriber.email}</span>
            </label>
          )}
          {subscriber.phone && (
            <label className="consent">
              <input type="checkbox" checked={Boolean(subscriber.wantsSms)} disabled={busy} onChange={(event) => void save(Boolean(subscriber.wantsEmail), event.currentTarget.checked, 'Saved.')} />
              <span>Text alerts to {subscriber.phone}</span>
            </label>
          )}
          <p>
            <button type="button" disabled={busy} onClick={() => void save(false, false, 'Stopped. You will receive nothing further.')}>Stop all alerts</button>
          </p>
        </section>
      )}
    </main>
  );
}
