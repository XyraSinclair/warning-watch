import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import DetectorPage from './DetectorPage';

const DASHBOARD_URLS = {
  business: import.meta.env.VITE_DASHBOARD_URL || '/dashboard.json',
  military: import.meta.env.VITE_MILITARY_DASHBOARD_URL || '/military-dashboard.json',
  untracked: import.meta.env.VITE_UNTRACKED_DASHBOARD_URL || '/untracked-dashboard.json',
} as const;

const CATEGORY_LABELS: Record<CohortKind, string> = {
  business: 'Business jets',
  military: 'Military',
  untracked: 'Untracked',
};

const HALF_HOUR_MS = 30 * 60 * 1000;
const PAGE_REFRESH_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEVEL_COUNT = 5;
const DEFAULT_ALARM_SIGMA = 4.8;

type CohortKind = 'business' | 'military' | 'untracked';

type DashboardResponse = {
  mode?: string;
  warning?: string | null;
  cohort?: {
    configured?: boolean;
    trackedCount?: number | null;
    sourceLabel?: string | null;
    cohortType?: string | null;
  };
  liveStatus?: {
    providerLabel?: string;
    cadenceMinutes?: number;
    lastSuccessAt?: string | null;
    latestSampledAt?: string | null;
    lastError?: string | null;
    matchedCount?: number | null;
    airborneCount?: number | null;
    concurrentCount?: number | null;
  };
  current?: CurrentSignal;
  signals?: {
    composite?: CompositeSignal;
  };
  liveAircraft?: Aircraft[];
  trends?: {
    archive?: PackedArchive | ArchivePoint[];
    holidayWindows?: HolidayWindow[];
  };
};

type CurrentSignal = {
  modelReady?: boolean;
  asOf?: string;
  concurrentCount?: number;
  baselineMean?: number;
  baselineStdDev?: number;
  effectiveBaselineStdDev?: number;
  zScore?: number;
  rawZScore?: number;
  varianceAdjustedZScore?: number;
  absoluteExcessWeight?: number;
  gaugeValue?: number;
  alertLevel?: string;
  emergencyLevel?: number;
  alarmSigmaThreshold?: number;
  elevatedSigmaThreshold?: number;
};

type CompositeSignal = {
  modelReady?: boolean;
  asOf?: string;
  actualConcurrentCount?: number;
  expectedConcurrentCount?: number;
  expectedConcurrentStdDev?: number;
  effectiveConcurrentStdDev?: number;
  rawSigmaShift?: number;
  varianceAdjustedSigmaShift?: number;
  absoluteExcessWeight?: number;
  sigmaShift?: number;
  emergencyLevel?: number;
  gaugeValue?: number;
  alarmSigmaThreshold?: number;
  concurrentPredictionModel?: string;
  weeklySampleCount?: number;
  timeOfWeekSampleCount?: number;
};

type PackedArchive = {
  v: 1;
  t0: string;
  tr?: [number, number][];
  c?: number[];
  p?: number[];
  s?: number[];
  z?: number[];
};

type ArchivePoint = {
  sampledAt?: string;
  concurrentCount?: number;
  predictedConcurrentCount?: number;
  predictedConcurrentStdDev?: number;
  divergence?: number;
  sigmaShift?: number;
  emergencyLevel?: number;
};

type HolidayWindow = {
  id?: string;
  label?: string;
  startsAt?: string;
  endsAt?: string;
};

type Aircraft = {
  hex?: string;
  registration?: string | null;
  label?: string | null;
  observed_at?: string;
  observedAt?: string;
  lat?: number;
  lon?: number;
  altitudeFt?: number | null;
  groundSpeedKt?: number | null;
  track?: number | null;
  isAirborne?: boolean;
  path?: Array<{ observedAt?: string; lat?: number; lon?: number }>;
  cohortKind?: CohortKind;
  ownerOperator?: string | null;
  markerId?: string;
};

type AlertEvent = {
  id: number;
  kind: string;
  severity: string;
  cohort: string;
  occurredAt: string;
  title: string;
  message: string;
  status: string;
};

type TakeoffEvent = {
  id: number;
  cohort: string;
  hex: string;
  registration?: string | null;
  label?: string | null;
  observedAt: string;
  altitudeFt?: number | null;
  groundSpeedKt?: number | null;
};

type LoadedDashboards = Partial<Record<CohortKind, DashboardResponse>>;
type SelectedCohorts = Record<CohortKind, boolean>;

type SignalMath = {
  divergence: number;
  sigmaShift: number;
  rawSigmaShift: number;
  varianceAdjustedSigmaShift: number;
  effectiveBaselineStdDev: number;
  absoluteExcessWeight: number;
  emergencyLevel: number;
};

type CombinedDashboard = {
  selectedKinds: CohortKind[];
  selectedLabels: string[];
  primary: DashboardResponse;
  liveAircraft: Aircraft[];
  archive: ArchivePoint[];
  holidayWindows: HolidayWindow[];
  trackedCount: number | null;
  actualCount: number;
  expectedCount: number;
  stdDev: number;
  alarmSigmaThreshold: number;
  signal: CurrentSignal & SignalMath;
  asOf?: string;
  assessmentProblem?: string;
  providerStatus: string;
  providerWarning?: string | null;
  modelCounts: ModelCount[];
  seats: SeatEstimate;
};

type ModelCount = {
  label: string;
  count: number;
  capacity: number | null;
  wiki?: string;
};

type SeatEstimate = {
  knownAircraftCount: number;
  totalAircraftCount: number;
  knownSeats: number;
  estimatedSeats: number | null;
};

async function fetchDashboard(kind: CohortKind, baseUrl: string, signal: AbortSignal): Promise<[CohortKind, DashboardResponse]> {
  const url = new URL(baseUrl, window.location.href);
  url.searchParams.set('v', String(Math.floor(Date.now() / PAGE_REFRESH_MS)));
  const response = await fetch(url, { cache: 'no-store', signal });
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${CATEGORY_LABELS[kind]} request failed with ${response.status} ${response.statusText}`);
  }
  if (!contentType.includes('json')) {
    throw new Error(`${CATEGORY_LABELS[kind]} returned ${contentType || 'an unknown content type'}`);
  }
  return [kind, JSON.parse(text) as DashboardResponse];
}

type SignupContacts = { email: string | null; phone: string | null; smsConsent: boolean };

type SignupResult =
  | { mode: 'checkout'; checkoutUrl: string; sessionId: string | null; reused: boolean }
  | { mode: 'local'; emailEnabled: boolean; smsEnabled: boolean; confirmationPending: string[]; managementPath: string | null };

class CheckoutUnavailableError extends Error {}

async function readApiPayload(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    const body = await response.text();
    return { error: body || `${response.status} ${response.statusText}` };
  }

  const payload = await response.json();
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function apiErrorMessage(payload: Record<string, unknown>, fallback: string) {
  return typeof payload.error === 'string' && payload.error ? payload.error : fallback;
}

async function createCheckoutSignup(contacts: SignupContacts): Promise<SignupResult> {
  const response = await fetch('/api/signup/create-checkout-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: contacts.email, phone: contacts.phone, smsConsent: contacts.smsConsent }),
  });
  if (response.status === 404 || response.status === 405 || response.status === 503) {
    throw new CheckoutUnavailableError('Checkout API is not available on this deployment.');
  }

  const payload = await readApiPayload(response);
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, `Checkout failed with HTTP ${response.status}`));
  }
  if (typeof payload.checkoutUrl !== 'string' || !payload.checkoutUrl) {
    throw new Error('Checkout API did not return a Stripe checkout URL.');
  }

  return {
    mode: 'checkout',
    checkoutUrl: payload.checkoutUrl,
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : null,
    reused: payload.reused === true,
  };
}

async function createLocalNotificationSignup(contacts: SignupContacts): Promise<SignupResult> {
  const response = await fetch('/api/notifications/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: contacts.email, phone: contacts.phone, smsConsent: contacts.smsConsent }),
  });
  const payload = await readApiPayload(response);
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, `Signup failed with HTTP ${response.status}`));
  }

  return {
    mode: 'local',
    emailEnabled: payload.emailEnabled === true,
    smsEnabled: payload.smsEnabled === true,
    confirmationPending: Array.isArray(payload.confirmationPending)
      ? payload.confirmationPending.filter((entry): entry is string => typeof entry === 'string')
      : [],
    managementPath: typeof payload.managementPath === 'string' ? payload.managementPath : null,
  };
}

async function createNotificationSignup(contacts: SignupContacts): Promise<SignupResult> {
  try {
    return await createCheckoutSignup(contacts);
  } catch (error) {
    if (error instanceof CheckoutUnavailableError) {
      return createLocalNotificationSignup(contacts);
    }
    throw error;
  }
}

type BrowserPushSignupResult = {
  id: string | null;
  pushEnabled: boolean;
  reused: boolean;
};

function browserPushUnsupportedReason() {
  if (!('serviceWorker' in navigator)) {
    return 'This browser does not support service workers.';
  }
  if (!('PushManager' in window)) {
    return 'This browser does not support push notifications.';
  }
  if (!('Notification' in window)) {
    return 'This browser does not expose notification permission controls.';
  }
  if (!window.isSecureContext) {
    return 'Browser push requires HTTPS.';
  }
  return null;
}

function base64UrlToUint8Array(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = window.atob(padded);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

async function fetchBrowserPushPublicKey() {
  const response = await fetch('/api/push/vapid-public-key', { cache: 'no-store' });
  const payload = await readApiPayload(response);
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, `Browser push setup failed with HTTP ${response.status}`));
  }
  if (typeof payload.publicKey !== 'string' || !payload.publicKey) {
    throw new Error('Browser push is not configured on this deployment.');
  }
  return payload.publicKey;
}

async function enableBrowserPushSignup(): Promise<BrowserPushSignupResult> {
  const unsupportedReason = browserPushUnsupportedReason();
  if (unsupportedReason) {
    throw new Error(unsupportedReason);
  }
  if (Notification.permission === 'denied') {
    throw new Error('Notification permission is blocked in this browser.');
  }
  const publicKey = await fetchBrowserPushPublicKey();
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }
  const registration = await navigator.serviceWorker.register('/ews-service-worker.js');
  const existingSubscription = await registration.pushManager.getSubscription();
  const subscription =
    existingSubscription ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(publicKey),
    }));
  const response = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  const payload = await readApiPayload(response);
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, `Browser push signup failed with HTTP ${response.status}`));
  }
  const subscriber = payload.subscriber && typeof payload.subscriber === 'object' ? (payload.subscriber as Record<string, unknown>) : {};
  return {
    id: typeof subscriber.id === 'string' || typeof subscriber.id === 'number' ? String(subscriber.id) : null,
    pushEnabled: payload.pushEnabled === true || subscriber.pushEnabled === true,
    reused: subscriber.reused === true,
  };
}

type ManagedSubscriber = {
  id: string | number;
  status: string;
  source?: string | null;
  accountEmail?: string | null;
  email?: string | null;
  phone?: string | null;
  phoneCountryName?: string | null;
  smsSupported?: boolean;
  wantsEmail?: boolean;
  wantsSms?: boolean;
  currentPeriodEnd?: string | null;
  stripeCancelAtPeriodEnd?: boolean;
  hasStripeSubscription?: boolean;
  stripeBillingPortalUrl?: string | null;
};

type EventSignalRecord = {
  id: string;
  source: string;
  event: string;
  phase: string;
  windowStart?: string | null;
  windowEnd?: string | null;
  timezone?: string | null;
  label?: string | null;
  classificationLabel?: string | null;
  severity?: string | null;
  method?: string | null;
  distanceMiles?: number | null;
  peakResidual?: number | null;
  observedAircraft?: number | null;
  expectedAircraft?: number | null;
  observedTakeoffs?: number | null;
  expectedTakeoffs?: number | null;
  takeoffRateZScore?: number | null;
  sampleCount?: number | null;
  takeoffEvents?: number | null;
  landingEvents?: number | null;
  provenance?: string | null;
  status?: string | null;
  sampleAircraft?: string[];
};

async function fetchEventSignals(): Promise<{ generatedAt: string | null; records: EventSignalRecord[] }> {
  const response = await fetch('/api/event-signals', { cache: 'no-store' });
  const payload = await readApiPayload(response);
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, `Event signals request failed with HTTP ${response.status}`));
  }
  return {
    generatedAt: typeof payload.generatedAt === 'string' ? payload.generatedAt : null,
    records: Array.isArray(payload.records) ? (payload.records as EventSignalRecord[]) : [],
  };
}

function requireManagedSubscriber(payload: Record<string, unknown>): ManagedSubscriber {
  if (!payload.subscriber || typeof payload.subscriber !== 'object') {
    throw new Error('Management API did not return subscriber settings.');
  }
  return payload.subscriber as ManagedSubscriber;
}

async function fetchManagedSubscriber(subscriber: string, token: string): Promise<ManagedSubscriber> {
  const params = new URLSearchParams({ subscriber, token });
  const response = await fetch(`/api/manage/subscriber?${params.toString()}`, { cache: 'no-store' });
  const payload = await readApiPayload(response);
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, `Management request failed with HTTP ${response.status}`));
  }
  return requireManagedSubscriber(payload);
}

async function saveManagedSubscriber(payload: Record<string, unknown>): Promise<ManagedSubscriber> {
  const response = await fetch('/api/manage/subscriber', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const responsePayload = await readApiPayload(response);
  if (!response.ok) {
    throw new Error(apiErrorMessage(responsePayload, `Management update failed with HTTP ${response.status}`));
  }
  return requireManagedSubscriber(responsePayload);
}


function App() {
  const path = window.location.pathname;
  // One public page. Subscription plumbing keeps its own routes because those
  // links arrive by email; nothing else is a destination.
  const page = path.startsWith('/signup') ? <SignupPage />
    : path.startsWith('/manage') ? <ManagePage />
    : <DetectorPage />;
  return <main>{page}{path === '/' && <FeedbackWidget />}</main>;
}

const FEEDBACK_API = 'https://api.scry.io/v1/feedback';
const FEEDBACK_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const FEEDBACK_AUDIO_LIMIT = 120;

function feedbackBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result.slice(reader.result.indexOf(',') + 1))
      : reject(new Error('Could not read attachment.'));
    reader.onerror = () => reject(new Error('Could not read attachment.'));
    reader.readAsDataURL(blob);
  });
}

function FeedbackMediaPreview({ blob, audio = false }: { blob: Blob; audio?: boolean }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return audio ? <audio controls src={url || undefined} aria-label="Recorded voice note" />
    : <img src={url || undefined} alt="Attached screenshot preview" />;
}

function FeedbackWidget() {
  const dialog = useRef<HTMLDialogElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const recordingTimer = useRef<number | undefined>(undefined);
  const permissionGeneration = useRef(0);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('suggestion');
  const [content, setContent] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [audio, setAudio] = useState<{ blob: Blob; duration: number } | null>(null);
  const [recording, setRecording] = useState(false);
  const [requestingMic, setRequestingMic] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const [config, setConfig] = useState<{ enabled: boolean; audio: boolean; duration: number } | null>(null);
  const [configError, setConfigError] = useState('');
  const [configAttempt, setConfigAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), 10000);
    setConfigError('');
    void fetch(`${FEEDBACK_API}/config`, {
      credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (typeof data.enabled !== 'boolean' || typeof data.audio_enabled !== 'boolean' ||
          !Number.isInteger(data.max_audio_duration_secs) || data.max_audio_duration_secs < 1) throw new Error();
      if (active) setConfig({ enabled: data.enabled, audio: data.audio_enabled, duration: Math.min(FEEDBACK_AUDIO_LIMIT, data.max_audio_duration_secs) });
    }).catch(() => {
      if (active) setConfigError('Could not check feedback availability.');
    }).finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [open, configAttempt]);

  useEffect(() => {
    if (open && !dialog.current?.open) {
      dialog.current?.showModal();
      textInput.current?.focus();
    } else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  function stopRecording() {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    clearInterval(recordingTimer.current);
    recordingTimer.current = undefined;
  }

  useEffect(() => () => {
    permissionGeneration.current += 1;
    const active = recorder.current;
    if (active) {
      active.onstop = null;
      if (active.state === 'recording') active.stop();
      active.stream.getTracks().forEach((track) => track.stop());
    }
    clearInterval(recordingTimer.current);
  }, []);

  useEffect(() => {
    const stopHiddenRecording = () => {
      if (!document.hidden) return;
      permissionGeneration.current += 1;
      setRequestingMic(false);
      stopRecording();
    };
    document.addEventListener('visibilitychange', stopHiddenRecording);
    return () => document.removeEventListener('visibilitychange', stopHiddenRecording);
  }, []);

  function close() {
    permissionGeneration.current += 1;
    setRequestingMic(false);
    stopRecording();
    setOpen(false);
    launcher.current?.focus();
  }

  async function startRecording() {
    if (requestingMic || recording || audio || pending) return;
    setMessage('');
    setSuccess(false);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setMessage('Voice recording is unavailable in this browser. You can still send text or images.');
      return;
    }
    const generation = ++permissionGeneration.current;
    setRequestingMic(true);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== permissionGeneration.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
        .find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('No supported recording format is available.');
      const active = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
      recorder.current = active;
      const chunks: Blob[] = [];
      let bytes = 0;
      let failed = false;
      const started = performance.now();
      active.ondataavailable = (event) => {
        bytes += event.data.size;
        if (bytes > 2 * 1024 * 1024) {
          failed = true;
          setMessage('Voice note exceeded 2 MB. Record a shorter note.');
          stopRecording();
        } else if (event.data.size) chunks.push(event.data);
      };
      active.onerror = () => { failed = true; setMessage('Recording failed. Please try again.'); stopRecording(); };
      active.onstop = () => {
        active.stream.getTracks().forEach((track) => track.stop());
        recorder.current = null;
        clearInterval(recordingTimer.current);
        recordingTimer.current = undefined;
        setRecording(false);
        const duration = Math.max(1, Math.round((performance.now() - started) / 1000));
        if (duration > (config?.duration ?? FEEDBACK_AUDIO_LIMIT)) {
          setMessage('The voice note exceeded the duration limit. Record a shorter note.');
        } else if (!failed && bytes) {
          setAudio({ blob: new Blob(chunks, { type: active.mimeType }), duration });
        } else if (!failed) setMessage('The recording was empty. Please try again.');
      };
      active.start(500);
      setRecording(true);
      setRecordingSeconds(0);
      recordingTimer.current = window.setInterval(() => {
        const seconds = Math.floor((performance.now() - started) / 1000);
        setRecordingSeconds(seconds);
        if (seconds >= (config?.duration ?? FEEDBACK_AUDIO_LIMIT)) stopRecording();
      }, 250);
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (generation === permissionGeneration.current) setMessage(error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Microphone access was denied. You can still send text or images.'
        : error instanceof Error ? error.message : 'Could not start recording.');
    } finally {
      if (generation === permissionGeneration.current) setRequestingMic(false);
    }
  }

  function addImages(files: FileList | null) {
    if (!files) return;
    setSuccess(false);
    const next = [...images, ...Array.from(files)];
    if (next.length > 4 || next.some((file) => !FEEDBACK_IMAGE_TYPES.includes(file.type) || !file.size || file.size > 5 * 1024 * 1024) ||
        next.reduce((total, file) => total + file.size, 0) > 12 * 1024 * 1024) {
      setMessage('Use up to four PNG, JPEG, GIF, or WebP images: 5 MB each, 12 MB total. Existing attachments are unchanged.');
      return;
    }
    setImages(next);
    setMessage('');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || recording || requestingMic) return;
    setSuccess(false);
    if (!content.trim() && !audio && !images.length) { setMessage('Add text, a voice note, or images.'); return; }
    if (content.length > 5000 || content.includes('\0')) { setMessage('Use at most 5,000 characters, without null characters.'); return; }
    if (config && !config.enabled) { setMessage('Feedback is currently unavailable. Your draft is unchanged.'); return; }
    sending.current = true;
    setPending(true);
    setMessage('');
    const controller = new AbortController();
    let timer: number | undefined;
    let dispatched = false;
    try {
      const attachments = await Promise.all(images.map(async (file) => ({
        image_base64: await feedbackBase64(file), content_type: file.type,
      })));
      const body = {
        feedback_type: kind, content: content.trim(), channel: 'warning-watch',
        // Only the route is context. Never send query/hash, URL credentials, or a referrer.
        page_url: `${window.location.origin}${window.location.pathname}`,
        metadata: { channel: 'warning-watch' },
        ...(audio || images.length ? {
          images: attachments,
          ...(audio ? { audio_base64: await feedbackBase64(audio.blob), audio_duration_secs: audio.duration, audio_content_type: audio.blob.type } : {}),
        } : {}),
      };
      timer = window.setTimeout(() => controller.abort(), 20000);
      dispatched = true;
      const response = await fetch(`${FEEDBACK_API}${audio || images.length ? '/audio' : ''}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        dispatched = false;
        throw new Error(response.status === 429 ? 'Feedback limit reached. Try again within an hour; your draft is unchanged.'
          : response.status === 400 || response.status === 413 ? 'The intake rejected this feedback. Check the text and attachments; your draft is unchanged.'
          : 'Feedback is unavailable. Your draft is unchanged; try later.');
      }
      const data = await response.json();
      if (response.status !== 201 || typeof data.id !== 'string' ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data.id) ||
          data.status !== 'new' || data.feedback_type !== kind || !Number.isFinite(Date.parse(data.created_at))) throw new Error();
      setSuccess(true);
      setMessage(`Feedback saved. Reference ${data.id.slice(0, 8)}.`);
      setContent('');
      setImages([]);
      setAudio(null);
    } catch (error) {
      setMessage(dispatched ? 'Delivery could not be confirmed. Your draft is unchanged; retrying may send a duplicate.'
        : error instanceof Error ? error.message : 'Could not prepare feedback. Your draft is unchanged.');
    } finally {
      clearTimeout(timer);
      sending.current = false;
      setPending(false);
    }
  }

  return <>
    <button ref={launcher} type="button" className="feedback-launcher" aria-haspopup="dialog"
      aria-controls="feedback-dialog" aria-expanded={open} onClick={() => setOpen(true)}>Feedback</button>
    <dialog ref={dialog} id="feedback-dialog" className="feedback-dialog" aria-labelledby="feedback-title"
      aria-describedby="feedback-notice" onCancel={(event) => { event.preventDefault(); close(); }}
      onClose={() => { setOpen(false); launcher.current?.focus(); }}>
      <div className="feedback-heading"><h2 id="feedback-title">Feedback</h2><button type="button" onClick={close} aria-label="Close feedback">Close</button></div>
      <p id="feedback-notice" className="feedback-notice">Not an emergency service or monitored in real time. For immediate danger, contact local emergency services.</p>
      <p className="feedback-privacy">Sent anonymously to the shared Scry / ExoPriors feedback queue. The page route and your IP address accompany it. Avoid sensitive information. Drafts stay only in this tab until sent or reloaded.</p>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={pending}><legend>Feedback type</legend><div className="feedback-kinds">
          {[['suggestion', 'Idea'], ['bug', 'Bug'], ['other', 'Other']].map(([value, label]) =>
            <label key={value}><input type="radio" name="feedback-kind" value={value} checked={kind === value} onChange={() => setKind(value)} />{label}</label>)}
        </div></fieldset>
        <label htmlFor="feedback-content">What should we know?</label>
        <textarea ref={textInput} id="feedback-content" rows={5} maxLength={5000} value={content} disabled={pending}
          onChange={(event) => { setContent(event.target.value); setSuccess(false); setMessage(''); }} />
        <small>{content.length.toLocaleString()} / 5,000 characters</small>
        <label className="feedback-upload">Add images
          <input type="file" accept={FEEDBACK_IMAGE_TYPES.join(',')} multiple disabled={pending}
            onChange={(event) => { addImages(event.target.files); event.target.value = ''; }} />
        </label>
        <small>Up to four images; 5 MB each, 12 MB total.</small>
        {images.length > 0 && <ul className="feedback-images">{images.map((file, index) => <li key={`${file.name}-${index}`}>
          <FeedbackMediaPreview blob={file} /><span>{file.name}</span><button type="button" disabled={pending}
            aria-label={`Remove image ${index + 1}: ${file.name}`} onClick={() => setImages((current) => current.filter((_, item) => item !== index))}>Remove</button>
        </li>)}</ul>}
        <div className="feedback-voice">
          {!audio && <button type="button" disabled={pending || requestingMic || !config?.audio} onClick={() => recording ? stopRecording() : void startRecording()}>
            {recording ? `Stop recording (${recordingSeconds}s)` : requestingMic ? 'Waiting for microphone…' : 'Record voice note'}
          </button>}
          <small>Voice: up to {config?.duration ?? FEEDBACK_AUDIO_LIMIT} seconds, 2 MB. Recording stops when you close this form.</small>
          {audio && <><FeedbackMediaPreview blob={audio.blob} audio /><button type="button" disabled={pending} onClick={() => setAudio(null)}>Remove voice note</button></>}
        </div>
        {config && !config.enabled && <p role="status">Feedback is currently unavailable. Your draft is unchanged.</p>}
        {configError && <p role="status">{configError} <button type="button" disabled={pending} onClick={() => setConfigAttempt((value) => value + 1)}>Check again</button> Text and images can still be attempted.</p>}
        {message && <p className={success ? 'feedback-result' : 'feedback-error'} role={success ? 'status' : 'alert'}>{message}</p>}
        <button className="feedback-submit" type="submit" disabled={pending || recording || requestingMic || config?.enabled === false}>
          {pending ? 'Sending…' : 'Send feedback'}
        </button>
      </form>
    </dialog>
  </>;
}

function DashboardPage() {
  const [dashboards, setDashboards] = useState<LoadedDashboards>({});
  const [selected, setSelected] = useState<SelectedCohorts>({ business: true, military: false, untracked: false });
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const [emergencyTheme, setEmergencyTheme] = useState(false);
  const [alertEvents, setAlertEvents] = useState<AlertEvent[]>([]);
  const [takeoffEvents, setTakeoffEvents] = useState<TakeoffEvent[]>([]);
  const [operationsError, setOperationsError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('emergency-color-scheme', emergencyTheme);
  }, [emergencyTheme]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let controller: AbortController | null = null;

    async function load() {
      if (inFlight) return;
      inFlight = true;
      const active = new AbortController();
      controller = active;
      const deadline = window.setTimeout(() => active.abort(), 20000);
      setStatus((current) => (current === 'ready' ? 'ready' : 'loading'));
      setError(null);
      try {
        const results = await Promise.allSettled(
          (Object.entries(DASHBOARD_URLS) as Array<[CohortKind, string]>)
            .map(([kind, baseUrl]) => fetchDashboard(kind, baseUrl, active.signal)),
        );
        if (cancelled) return;
        const entries: Array<[CohortKind, DashboardResponse]> = [];
        const optionalErrors: string[] = [];
        for (const result of results) {
          if (result.status === 'fulfilled') {
            entries.push(result.value);
          } else {
            optionalErrors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
          }
        }
        if (!entries.length) throw new Error(optionalErrors.join('; ') || 'No cohort data is available.');
        setDashboards(Object.fromEntries(entries) as LoadedDashboards);
        setLastFetchedAt(new Date().toISOString());
        setStatus('ready');
        setError(optionalErrors.length ? `Cohort data unavailable: ${optionalErrors.join('; ')}` : null);
      } catch (loadError) {
        if (cancelled) return;
        setStatus('error');
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        window.clearTimeout(deadline);
        inFlight = false;
      }
    }

    load();
    const interval = window.setInterval(load, PAGE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      controller?.abort();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let controller: AbortController | null = null;

    async function loadOperations() {
      if (inFlight) return;
      inFlight = true;
      const active = new AbortController();
      controller = active;
      const deadline = window.setTimeout(() => active.abort(), 20000);
      setOperationsError(null);
      try {
        const [alertsResponse, takeoffsResponse] = await Promise.all([
          fetch('/api/alerts?limit=8', { cache: 'no-store', signal: active.signal }),
          fetch('/api/takeoffs?limit=8', { cache: 'no-store', signal: active.signal }),
        ]);
        if (!alertsResponse.ok) throw new Error(`Alert event request failed with ${alertsResponse.status}`);
        if (!takeoffsResponse.ok) throw new Error(`Takeoff event request failed with ${takeoffsResponse.status}`);
        const [alertsPayload, takeoffsPayload] = await Promise.all([alertsResponse.json(), takeoffsResponse.json()]);
        if (cancelled) return;
        setAlertEvents(Array.isArray(alertsPayload.events) ? alertsPayload.events : []);
        setTakeoffEvents(Array.isArray(takeoffsPayload.events) ? takeoffsPayload.events : []);
      } catch (loadError) {
        if (cancelled) return;
        setOperationsError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        window.clearTimeout(deadline);
        inFlight = false;
      }
    }

    loadOperations();
    const interval = window.setInterval(loadOperations, PAGE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      controller?.abort();
    };
  }, []);

  const combined = useMemo(() => combineDashboards(dashboards, selected), [dashboards, selected]);

  function toggleKind(kind: CohortKind) {
    setSelected((current) => {
      const next = { ...current, [kind]: !current[kind] };
      if (!Object.values(next).some(Boolean)) return current;
      return next;
    });
  }

  if (status === 'loading' && !combined) {
    return <StatusPage title="Loading dashboard" detail="Fetching live aircraft anomaly snapshots." />;
  }

  if (status === 'error' && !combined) {
    return <StatusPage title="Dashboard unavailable" detail={error ?? 'The dashboard data request failed.'} tone="error"><CohortControls selected={selected} onToggle={toggleKind} /></StatusPage>;
  }

  if (!combined) {
    return <StatusPage title="Selected cohort unavailable" detail="No current signal can be assessed. Select another aircraft category or wait for recovery." tone="error"><CohortControls selected={selected} onToggle={toggleKind} /></StatusPage>;
  }

  return (
    <main className="app-shell">
      <div className="background-wallpaper" aria-hidden="true" />
      <p className="signup-teaser">
        <a href="#get-alerts">Get alerts</a> — phone push, RSS, browser push, email, or text. <a href="/event-signals">Review event signals</a>.
      </p>

      {error ? <div className="status-banner status-banner-error"><strong>Refresh error:</strong> {error}</div> : null}

      <DialPanel combined={combined} onEmergencyLevelTap={() => setEmergencyTheme((value) => !value)} />

      <HeroPanel />

      <section className="top-grid">
        <RealtimeMap
          aircraft={combined.liveAircraft}
          providerStatus={combined.providerStatus}
          providerWarning={combined.providerWarning}
          lastFetchedAt={lastFetchedAt}
        />
        <ArchivePanel combined={combined} selected={selected} onToggle={toggleKind} />
      </section>

      <section className="secondary-grid">
        <ModelList models={combined.modelCounts} />
        <OperationsPanel alerts={alertEvents} takeoffs={takeoffEvents} error={operationsError} />
      </section>

      <GetAlertsPanel />
      <ReadingPanel />
      <AboutPanel selectedLabels={combined.selectedLabels} />
      <FaqPanel />
      <UpdatesPanel />
    </main>
  );
}

function StatusPage({ title, detail, tone = 'normal', children }: { title: string; detail: string; tone?: 'normal' | 'error'; children?: ReactNode }) {
  return (
    <main className="app-shell">
      <section className={`panel loading-panel ${tone === 'error' ? 'error-panel' : ''}`}>
        <h1>{title}</h1>
        <p>{detail}</p>
        {children}
      </section>
    </main>
  );
}

function CohortControls({ selected, onToggle }: { selected: SelectedCohorts; onToggle: (kind: CohortKind) => void }) {
  return <fieldset className="chart-checkbox-group cohort-toggle-group">
    <legend>Aircraft categories</legend>
    {(Object.keys(CATEGORY_LABELS) as CohortKind[]).map((kind) => (
      <label key={kind} className={`chart-checkbox-option cohort-toggle-option ${selected[kind] ? 'cohort-toggle-option-active' : ''}`}>
        <input type="checkbox" checked={selected[kind]} onChange={() => onToggle(kind)} />
        {CATEGORY_LABELS[kind]}
      </label>
    ))}
  </fieldset>;
}

function HeroPanel() {
  return (
    <section className="panel hero-copy-panel">
      <h1>Apocalypse Early Warning System</h1>
      <p>
        A continuously running instrument at <strong>warning.watch</strong>. It checks for new aircraft data every two
        minutes and compares business-jet, military, and untracked-aircraft activity against historical baselines.
        The current upstream archive publishes 30-minute slots; faster polling does not make those observations real time.
      </p>
      <p>
        Unusual aircraft movements can provide evidence worth investigating. They do not establish anyone&apos;s
        intentions, predict an attack, or prove that conditions are safe.
      </p>
      <p>
        Every alert must carry its evidence. Missing baselines mean the detector cannot assess an anomaly; stale data means
        the instrument is unavailable. Neither is an all-clear. Follow official emergency instructions.
      </p>
      <p className="hero-link-row">
        <a href="#get-alerts">Get alerts</a> / <a href="#how-to-read">How to read this</a> /{' '}
        <a href="#methodology">Methodology</a> / <a href="/rss.xml">RSS</a> / <a href="/event-signals">Event signals</a>
      </p>
    </section>
  );
}

function GetAlertsPanel() {
  return (
    <section className="panel get-alerts-panel" id="get-alerts">
      <h2>Get Alerts</h2>
      <p className="panel-lede">
        Independent channels that fail independently — subscribe to at least two. All of them are free.
      </p>
      <div className="channel-list">
        <article className="channel-card">
          <h3>1. Phone push via ntfy (recommended)</h3>
          <p>
            Install the free, open-source <a href="https://ntfy.sh/">ntfy</a> app (
            <a href="https://apps.apple.com/us/app/ntfy/id1625396347">iOS</a> /{' '}
            <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy">Android</a>), tap <em>+ Subscribe to
            topic</em>, choose <em>Use another server</em>, and enter:
          </p>
          <p className="channel-code"><code>https://ntfy.warning.watch/warning-watch-alerts</code></p>
          <p>
            No account, no phone number, no vendor between you and the signal. The channel is served from this system&apos;s
            own infrastructure; publishing requires a private key, so nothing can spoof an alert onto it. Only elevated-and-above
            events are pushed.
          </p>
        </article>
        <article className="channel-card">
          <h3>2. RSS</h3>
          <p>
            Point any feed reader at <a href="/rss.xml"><code>https://warning.watch/rss.xml</code></a>. The feed updates on
            emergency-level changes and alert events, and works even if every push provider on earth is down.
          </p>
        </article>
        <article className="channel-card">
          <h3>3. Browser push</h3>
          <p>
            One tap on the <a href="/signup">signup page</a> — no email or phone required. Alerts arrive as system
            notifications on this device.
          </p>
        </article>
        <article className="channel-card">
          <h3>4. Email &amp; text message</h3>
          <p>
            <a href="/signup">Register here</a>. Both channels are double opt-in: nothing is ever sent to an address or number
            that has not clicked its own confirmation link. Contact details are encrypted at rest and used for alerts only.
            Delivery providers are being activated — registrations are stored now and your confirmation arrives the moment
            sending goes live.
          </p>
        </article>
        <article className="channel-card">
          <h3>System health — silence must be distinguishable from death</h3>
          <p>
            The instrument checks its own health every two minutes and publishes failures and
            recoveries to a separate operations channel:{' '}
            <code>https://ntfy.warning.watch/warning-watch-ops</code>. The dashboard above always shows the timestamp of the
            last ingested data slot — if it is more than 75 minutes old, treat the instrument as down, not the sky as calm.
          </p>
        </article>
      </div>
    </section>
  );
}

function ReadingPanel() {
  return (
    <section className="panel reading-panel" id="how-to-read">
      <h2>How To Read This</h2>
      <div className="about-copy">
        <p>
          The emergency level is a 1–5 measurement of deviation from a rolling historical baseline (same time-of-day window,
          trailing seven days), expressed through sigma thresholds:
        </p>
        <ul className="level-ladder">
          <li><strong>1 — Ordinary.</strong> Traffic within its normal envelope. This is the reading almost all of the time.</li>
          <li><strong>2 — Noted.</strong> Mildly above baseline; well within historical variation.</li>
          <li><strong>3 — Elevated.</strong> Meaningfully above baseline. Worth a glance at which cohort is driving it.</li>
          <li><strong>4 — High.</strong> Statistically unusual, or a clustered takeoff burst fired. Check corroboration.</li>
          <li><strong>5 — Extreme.</strong> Beyond the calibrated historical envelope of the selected cohort.</li>
        </ul>
        <p><strong>If you receive a high or extreme alert:</strong></p>
        <ol className="fire-steps">
          <li>Open the dashboard. Check the last-update timestamp first — a stale feed is a data problem, not an event.</li>
          <li>Look for corroboration: is more than one cohort elevated? Is the deviation sustained across multiple half-hour slots, or one hot sample?</li>
          <li>Cross-check the world: major wire services, official emergency channels for your country, other independent monitors.</li>
          <li>Remember what this is: a measurement of unusual aircraft activity, not knowledge of anyone&apos;s motive. Elite aviation also surges for summits, funerals, sporting finals, and weather.</li>
        </ol>
        <p>
          The system is deliberately conservative: a single anomalous reading proves little, and the copy on every alert says
          so. Sustained, corroborated, multi-cohort extremes are the signal worth your attention.
        </p>
      </div>
    </section>
  );
}

const LEVEL_NAMES: Record<number, string> = {
  1: 'NO ANOMALY',
  2: 'NOTED',
  3: 'ELEVATED',
  4: 'HIGH',
  5: 'EXTREME',
};

const LEVEL_MEANINGS: Record<number, string> = {
  1: 'No elevated activity in the latest sample. This is not an all-clear or a prediction of safety.',
  2: 'Mildly above baseline — well within historical variation.',
  3: 'Meaningfully above baseline. Watch which category is driving it.',
  4: 'Statistically unusual activity. Check corroboration before concluding anything.',
  5: 'Beyond the calibrated historical envelope. Verify against other sources now.',
};

// The reading a stranger under stress needs, in words before numbers.
function deviationSentence(actual: number, expected: number, sigma: number) {
  const difference = Math.round(actual - expected);
  const magnitude = Math.abs(sigma);
  const direction = difference >= 0 ? 'more' : 'fewer';
  const band =
    magnitude < 2
      ? 'well within the normal range'
      : magnitude < 3.5
        ? `on the ${difference >= 0 ? 'high' : 'low'} side of normal`
        : magnitude < 5
          ? `notably ${difference >= 0 ? 'above' : 'below'} normal`
          : `far ${difference >= 0 ? 'above' : 'below'} normal`;
  return `${formatInteger(Math.abs(difference))} ${direction} than the ~${formatInteger(Math.round(expected))} expected for this hour — ${band}.`;
}

const STALE_AFTER_MINUTES = 75;

function dataAgeMinutes(asOf: string | null | undefined, now: number) {
  const time = Date.parse(asOf ?? '');
  if (!Number.isFinite(time) || time > now + 60000) return null;
  return Math.max(0, Math.floor((now - time) / 60000));
}

function DialPanel({ combined, onEmergencyLevelTap }: { combined: CombinedDashboard; onEmergencyLevelTap: () => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(interval);
  }, []);
  const level = clampLevel(combined.signal.emergencyLevel);
  const seatCopy = combined.seats.estimatedSeats == null ? null : `≈${formatInteger(combined.seats.estimatedSeats)} passenger seats aloft`;
  const sigma = combined.signal.sigmaShift;
  const ageMinutes = dataAgeMinutes(combined.asOf, now);
  const stale = ageMinutes == null || ageMinutes >= STALE_AFTER_MINUTES;

  if (stale || combined.assessmentProblem) {
    return (
      <section className="panel dial-panel status-stale" aria-live="polite">
        <p className="status-kicker">Current status · {combined.selectedLabels.join(' + ')}</p>
        <p className="status-word">{ageMinutes == null || combined.assessmentProblem ? 'INSTRUMENT UNAVAILABLE' : 'INSTRUMENT STALE'}</p>
        <p className="status-meaning">
          {combined.assessmentProblem ?? (ageMinutes == null ? 'A selected cohort has missing or invalid measurement time.' : `The oldest selected measurement is ${formatInteger(ageMinutes)} minutes old (bound: ${STALE_AFTER_MINUTES} min).`)}
          {' '}The current combined signal cannot be assessed. Treat the instrument as down — <strong>not</strong> the sky as calm.
        </p>
        <p className="status-freshness">Oldest selected measurement {formatDateTime(combined.asOf)} · source slots 30 min · polling 2 min</p>
      </section>
    );
  }

  return (
    <section className={`panel dial-panel emergency-level-${level}`} aria-live="polite">
      <p className="status-kicker">Current status · {combined.selectedLabels.join(' + ')}</p>
      <button
        type="button"
        className="emergency-level-trigger"
        aria-label={`Emergency level ${level} of 5: ${LEVEL_NAMES[level]}`}
        onClick={onEmergencyLevelTap}
      >
        <span className="status-word">{LEVEL_NAMES[level]}</span>
        <span className="status-level-tag">level {level} of 5</span>
      </button>
      <p className="status-meaning">{LEVEL_MEANINGS[level]}</p>
      <p className="status-reading">
        <strong>{formatInteger(combined.actualCount)} airborne.</strong>{' '}
        {deviationSentence(combined.actualCount, combined.expectedCount, sigma)}
        {seatCopy ? ` ${seatCopy}.` : ''}
      </p>
      <p className="status-freshness">
        Oldest selected sample {ageMinutes === 0 ? 'just now' : `${formatInteger(ageMinutes)} min ago`} · source slots 30 min · polling 2 min · page refresh 1 min ·{' '}
        <span className="status-figures">deviation {formatSigned(sigma, 1)}σ vs expected {formatNumber(combined.expectedCount, 0)}</span>
      </p>
    </section>
  );
}

function ArchivePanel({ combined, selected, onToggle }: { combined: CombinedDashboard; selected: SelectedCohorts; onToggle: (kind: CohortKind) => void }) {
  const [windowDays, setWindowDays] = useState(3);
  const [offsetDays, setOffsetDays] = useState(0);
  const archive = combined.archive;
  const latestTime = Date.parse(archive.at(-1)?.sampledAt ?? '');
  const earliestTime = Date.parse(archive[0]?.sampledAt ?? '');
  const totalDays = Number.isFinite(latestTime) && Number.isFinite(earliestTime) ? Math.max(1, Math.ceil((latestTime - earliestTime) / DAY_MS)) : 1;
  const maxOffset = Math.max(0, totalDays - windowDays);
  const safeOffset = Math.min(offsetDays, maxOffset);
  const endTime = Number.isFinite(latestTime) ? latestTime - safeOffset * DAY_MS : Date.now();
  const startTime = endTime - windowDays * DAY_MS;
  const visible = archive.filter((point) => {
    const time = Date.parse(point.sampledAt ?? '');
    return Number.isFinite(time) && time >= startTime && time <= endTime;
  });
  const levels = visible.map((point) => ({ ...point, emergencyLevel: pointToEmergencyLevel(point, combined.alarmSigmaThreshold) }));

  function changeWindow(days: number) {
    setWindowDays(days);
    setOffsetDays((current) => Math.min(current, Math.max(0, totalDays - days)));
  }

  return (
    <section className="panel chart-panel history-panel">
      <div className="panel-header">
        <h2>Traffic archive</h2>
      </div>
      <div className="chart-toolbar">
        <div className="chart-range-copy">
          <strong>{formatShortDate(visible[0]?.sampledAt)} to {formatShortDate(visible.at(-1)?.sampledAt)}</strong>
          <span>{archive.length ? `${formatInteger(archive.length)} half-hour samples decoded` : 'No archive samples available'}</span>
        </div>
      </div>
      <div className="chart-range-toolbar">
        <label className="chart-slider-label">
          <span>Archive position</span>
          <input
            className="chart-range-slider"
            type="range"
            min={0}
            max={maxOffset}
            value={maxOffset - safeOffset}
            aria-label="Archive position"
            onChange={(event) => setOffsetDays(maxOffset - Number(event.currentTarget.value))}
          />
        </label>
      </div>
      <fieldset className="chart-radio-group">
        <legend>Historical archive window</legend>
        {[3, 7, 30].map((days) => (
          <label key={days} className="chart-radio-option">
            <input type="radio" name="archive-window" checked={windowDays === days} onChange={() => changeWindow(days)} />
            {days === 30 ? '1 month' : `${days} days`}
          </label>
        ))}
      </fieldset>
      <CohortControls selected={selected} onToggle={onToggle} />
      <LineChart
        title="Aircraft count history"
        data={visible}
        lines={[
          { key: 'concurrentCount', label: 'Airborne', color: '#1d4ed8' },
          { key: 'predictedConcurrentCount', label: 'Expected', color: '#8a8578' },
        ]}
        height={260}
      />
      <LineChart
        title="Emergency level history"
        data={levels}
        lines={[{
          key: 'emergencyLevel',
          label: 'Emergency level',
          // Red is reserved for actual alarm: a calm history draws calm.
          color: levels.some((point) => point.emergencyLevel >= 4)
            ? '#b91c1c'
            : levels.some((point) => point.emergencyLevel >= 3)
              ? '#b45309'
              : '#3d7a52',
        }]}
        minY={1}
        maxY={5}
        height={170}
      />
    </section>
  );
}

function LineChart({
  title,
  data,
  lines,
  minY,
  maxY,
  height,
}: {
  title: string;
  data: ArchivePoint[];
  lines: Array<{ key: keyof ArchivePoint; label: string; color: string }>;
  minY?: number;
  maxY?: number;
  height: number;
}) {
  const width = 860;
  const padding = { left: 54, right: 22, top: 18, bottom: 34 };
  const drawableWidth = width - padding.left - padding.right;
  const drawableHeight = height - padding.top - padding.bottom;
  const values = data.flatMap((point) => lines.map((line) => Number(point[line.key])).filter(Number.isFinite));
  const yMin = minY ?? Math.min(0, ...values);
  const yMax = maxY ?? Math.max(1, ...values);
  const ySpan = Math.max(1, yMax - yMin);
  const x = (index: number) => padding.left + (data.length <= 1 ? 0 : (index / (data.length - 1)) * drawableWidth);
  const y = (value: number) => padding.top + drawableHeight - ((value - yMin) / ySpan) * drawableHeight;
  const ticks = Array.from({ length: 5 }, (_, index) => yMin + (index / 4) * ySpan);
  const xTicks = makeDateTicks(data, 4);

  return (
    <div className="chart-frame">
      <div className="chart-subsection-header">
        <strong>{title}</strong>
        <span>{lines.map((line) => line.label).join(' / ')}</span>
      </div>
      <svg className="archive-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        <rect x={0} y={0} width={width} height={height} fill="transparent" />
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={padding.left} x2={width - padding.right} y1={y(tick)} y2={y(tick)} stroke="#d4d4d4" strokeWidth="1" />
            <text x={padding.left - 10} y={y(tick) + 4} textAnchor="end">{formatAxis(tick)}</text>
          </g>
        ))}
        {xTicks.map(({ label, index }) => (
          <text key={`${label}-${index}`} x={x(index)} y={height - 10} textAnchor="middle">{label}</text>
        ))}
        {lines.map((line) => {
          const path = data
            .map((point, index) => {
              const value = Number(point[line.key]);
              if (!Number.isFinite(value)) return null;
              return `${index === 0 ? 'M' : 'L'}${x(index).toFixed(2)},${y(value).toFixed(2)}`;
            })
            .filter(Boolean)
            .join(' ');
          return <path key={line.key} d={path} fill="none" stroke={line.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
    </div>
  );
}

function RealtimeMap({
  aircraft,
  providerStatus,
  lastFetchedAt,
  providerWarning,
}: {
  aircraft: Aircraft[];
  providerStatus?: string;
  lastFetchedAt?: string | null;
  providerWarning?: string | null;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const validAircraft = aircraft.filter((plane) => isFiniteCoordinate(plane.lat, plane.lon));
  const active = validAircraft.find((plane) => plane.markerId === activeId) ?? validAircraft[0];
  const width = 840;
  const height = 430;

  return (
    <section className="panel map-panel">
      <div className="panel-header">
        <h2>Live map</h2>
        <span className="map-badge">{formatInteger(validAircraft.length)} aircraft mapped</span>
      </div>
      <div className="map-frame">
        <div className="map-controls" aria-label="Map controls">
          <button type="button" className="map-control-button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(4, value * 1.5))}>+</button>
          <button type="button" className="map-control-button" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value / 1.5))}>−</button>
        </div>
        {active ? <AircraftHoverCard aircraft={active} /> : null}
        <svg className="map-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Live aircraft map">
          <rect className="map-sphere" x="1" y="1" width={width - 2} height={height - 2} rx="0" />
          {Array.from({ length: 11 }, (_, index) => -150 + index * 30).map((lon) => (
            <line key={`lon-${lon}`} className="map-graticule" x1={project(lon, -90, width, height).x} y1="0" x2={project(lon, 90, width, height).x} y2={height} />
          ))}
          {Array.from({ length: 7 }, (_, index) => -60 + index * 20).map((lat) => (
            <line key={`lat-${lat}`} className="map-graticule" x1="0" y1={project(0, lat, width, height).y} x2={width} y2={project(0, lat, width, height).y} />
          ))}
          <g transform={`translate(${width / 2} ${height / 2}) scale(${zoom}) translate(${-width / 2} ${-height / 2})`}>
            {validAircraft.map((plane, index) => {
              const { x, y } = project(plane.lon!, plane.lat!, width, height);
              const id = plane.markerId ?? `${plane.hex}-${index}`;
              const activeMarker = id === activeId;
              return (
                <g
                  key={id}
                  className={`map-marker map-marker-${plane.cohortKind ?? 'business'} ${activeMarker ? 'map-marker-active' : ''}`}
                  transform={`translate(${x.toFixed(2)} ${y.toFixed(2)})`}
                  tabIndex={0}
                  role="button"
                  aria-label={plane.label ?? plane.hex ?? 'Aircraft'}
                  onMouseEnter={() => setActiveId(id)}
                  onFocus={() => setActiveId(id)}
                  onClick={() => setActiveId(id)}
                >
                  <circle className="map-marker-halo" r="10" />
                  <path className="map-marker-plane" d="M0 -8 L5 6 L0 3 L-5 6 Z" />
                  <circle className="map-marker-hit" r="14" />
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      {providerWarning ? <p className="error-copy">{providerWarning}</p> : null}
      {providerStatus ? (
        <p className="panel-footnote">
          {providerStatus}
          {lastFetchedAt ? ` · page refreshed ${formatDateTime(lastFetchedAt)}` : ''}
        </p>
      ) : null}
    </section>
  );
}

function AircraftHoverCard({ aircraft }: { aircraft: Aircraft }) {
  return (
    <aside className="map-hover-card">
      <div className="map-hover-header">
        <strong>{aircraft.label || aircraft.registration || aircraft.hex || 'Unknown aircraft'}</strong>
        <span>{CATEGORY_LABELS[aircraft.cohortKind ?? 'business']}</span>
      </div>
      <dl className="map-hover-grid">
        <div>
          <dt>Hex</dt>
          <dd>{aircraft.hex ?? '—'}</dd>
        </div>
        <div>
          <dt>Registration</dt>
          <dd>{aircraft.registration ?? '—'}</dd>
        </div>
        <div>
          <dt>Altitude</dt>
          <dd>{formatNullableNumber(aircraft.altitudeFt, 0)} ft</dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd>{formatNullableNumber(aircraft.groundSpeedKt, 1)} kt</dd>
        </div>
        <div className="map-hover-coordinates">
          <dt>Owner / operator</dt>
          <dd>{aircraft.ownerOperator ?? '—'}</dd>
        </div>
        <div className="map-hover-coordinates">
          <dt>Observed</dt>
          <dd>{formatDateTime(aircraft.observed_at ?? aircraft.observedAt)}</dd>
        </div>
      </dl>
    </aside>
  );
}

function ModelList({ models }: { models: ModelCount[] }) {
  const visible = models.slice(0, 140);
  return (
    <section className="panel list-panel">
      <div className="panel-header">
        <h2>Airborne by aircraft model</h2>
        <span className="map-badge">{formatInteger(models.length)} types</span>
      </div>
      {visible.length ? (
        <ol className="flight-list model-list">
          {visible.map((model) => (
            <li key={model.label}>
              <div className="model-name-cell">
                <div className="model-title-row">
                  {model.wiki ? <a className="model-wiki-link" href={model.wiki}><strong>{model.label}</strong></a> : <strong>{model.label}</strong>}
                  {model.capacity ? <span className="model-passenger-label">{model.capacity}</span> : null}
                </div>
              </div>
              <span className="model-count">{formatInteger(model.count)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty-state">No aircraft are currently mapped for the selected cohorts.</p>
      )}
    </section>
  );
}

function OperationsPanel({ alerts, takeoffs, error }: { alerts: AlertEvent[]; takeoffs: TakeoffEvent[]; error: string | null }) {
  return (
    <section className="panel operations-panel">
      <div className="panel-header">
        <h2>Recent detections</h2>
        <span className="map-badge">{formatInteger(alerts.length)} queued</span>
      </div>
      {error ? <p className="signup-status signup-status-error">{error}</p> : null}
      <div className="operations-grid">
        <div>
          <h3>Recent alert events</h3>
          {alerts.length ? (
            <ol className="ops-list">
              {alerts.map((alert) => (
                <li key={alert.id}>
                  <strong>{alert.title}</strong>
                  <span>{alert.kind} · {alert.severity} · {alert.status}</span>
                  <time>{formatDateTime(alert.occurredAt)}</time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty-state">No alert events have been queued yet.</p>
          )}
        </div>
        <div>
          <h3>Recent takeoff detections</h3>
          {takeoffs.length ? (
            <ol className="ops-list">
              {takeoffs.map((takeoff) => (
                <li key={takeoff.id}>
                  <strong>{takeoff.label || takeoff.registration || takeoff.hex}</strong>
                  <span>{takeoff.cohort} · {formatNullableNumber(takeoff.altitudeFt, 0)} ft · {formatNullableNumber(takeoff.groundSpeedKt, 0)} kt</span>
                  <time>{formatDateTime(takeoff.observedAt)}</time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty-state">No takeoff transitions have been recorded for the current refresh window.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function AboutPanel({ selectedLabels }: { selectedLabels: string[] }) {
  return (
    <section className="panel about-panel">
      <h2 id="methodology">Methodology</h2>
      <div className="about-copy">
        <p>
          Every two minutes the pipeline checks for new global ADS-B Exchange archive slots. The source publishes 30-minute
          slots from aircraft transponders collected by a worldwide network of volunteer receivers. Each new slot is scored
          once for three cohorts: <strong>business jets</strong> (public airframe metadata keyed by ICAO hex),{' '}
          <strong>military aircraft</strong>, and <strong>non-ICAO untracked transponders</strong> (traffic that avoids
          standard registration). Currently showing: {selectedLabels.join(' + ')}.
        </p>
        <p>
          Each cohort&apos;s current count is compared against a rolling baseline for the same time-of-day window across the
          trailing week; the deviation in sigma sets the emergency level. Takeoff clustering is scored separately against a
          28-day rate history. No baseline means no alert — the system fails quiet, not noisy.
        </p>
        <p>
          The pipeline runs on independent, self-operated infrastructure: one server, systemd timers, SQLite archives with
          daily integrity-checked backups, a two-minute self-watchdog, and delivery channels that fail independently. The seat
          estimate is a maximum-capacity approximation from model labels — it is not a manifest and identifies no one.
        </p>
        <p>
          The concept and reference implementation are{' '}
          <a href="https://ews.kylemcdonald.net/">Kyle McDonald&apos;s EWS</a>; this is an independent implementation and
          deployment, open source at{' '}
          <a href="https://github.com/XyraSinclair/warning-watch">github.com/XyraSinclair/warning-watch</a>.
        </p>
      </div>
    </section>
  );
}

function FaqPanel() {
  return (
    <section className="panel faq-panel">
      <h2>FAQ</h2>
      <div className="faq-list">
        <article>
          <h3>Is this trying to detect missiles already inbound?</h3>
          <p>No. The signal is earlier behavioral change: unusual aircraft activity before public information catches up.</p>
        </article>
        <article>
          <h3>What counts as a business jet here?</h3>
          <p>The reference dataset uses public aircraft metadata keyed by ICAO hex and filters for known business-jet families.</p>
        </article>
        <article>
          <h3>Does level 5 prove an apocalypse is likely?</h3>
          <p>No. It means the selected public flight signal is historically extreme. It is an anomaly monitor, not proof of motive.</p>
        </article>
        <article>
          <h3>If nothing has fired, does that mean everything is fine?</h3>
          <p>
            It means this instrument measured nothing unusual — provided the instrument itself is alive. Check the last-update
            timestamp on the dashboard, or subscribe to the operations channel, which announces failures and recoveries. A
            silent broken monitor is the failure mode this system is engineered hardest against.
          </p>
        </article>
        <article>
          <h3>What happens to my email or phone number?</h3>
          <p>
            Encrypted at rest, used only to deliver alerts and your own management link, never shared or sold. Both channels
            are double opt-in, and every message carries an unsubscribe path. You can delete your subscription at any time.
          </p>
        </article>
        <article>
          <h3>Who runs this?</h3>
          <p>
            An independent operator, on self-owned infrastructure, with the full pipeline open source. There is no company, no
            ad model, and nothing for sale — the instrument exists because it should exist.
          </p>
        </article>
      </div>
    </section>
  );
}

function UpdatesPanel() {
  return (
    <section className="panel updates-panel">
      <h2>Updates</h2>
      <div className="updates-copy">
        <article className="update-entry">
          <h3>2026-08-28 — warning.watch is live</h3>
          <p>
            Public launch on owned infrastructure: Cloudflare-tunneled serving (no open inbound ports), self-hosted
            write-authenticated ntfy push, double opt-in email/SMS registration, daily integrity-checked database backups, and
            an hourly self-watchdog publishing to the operations channel. apoc.watch and earlywarning.watch redirect here.
          </p>
        </article>
        <article className="update-entry">
          <h3>Implementation notes</h3>
          <p>Independent React/Vite implementation of the reference EWS concept; no source code or assets from the reference repository are vendored.</p>
        </article>
      </div>
    </section>
  );
}

function SignupPage() {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [smsConsent, setSmsConsent] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managementPath, setManagementPath] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pushStatus, setPushStatus] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushSubmitting, setPushSubmitting] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('success') === '1') {
      setStatus('Checkout completed. Your notification subscription activates as soon as the payment webhook confirms.');
    } else if (params.get('canceled') === '1') {
      setError('Checkout was canceled before the notification subscription was activated.');
    }
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setStatus(null);
    setManagementPath(null);
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();
    if (!trimmedEmail && !trimmedPhone) {
      setError('Enter an email address, a phone number, or both before submitting.');
      return;
    }
    if (trimmedEmail && !/^\S+@\S+\.\S+$/.test(trimmedEmail)) {
      setError('Enter a valid email address.');
      return;
    }
    if (trimmedPhone && !/^\+?[0-9][0-9\s().-]{6,}$/.test(trimmedPhone)) {
      setError('Enter a phone number with country code if SMS alerts are desired.');
      return;
    }
    if (trimmedPhone && !smsConsent) {
      setError('Confirm SMS consent before subscribing a phone number.');
      return;
    }

    const contacts = { email: trimmedEmail || null, phone: trimmedPhone || null, smsConsent: Boolean(trimmedPhone && smsConsent) };
    setSubmitting(true);
    try {
      const result = await createNotificationSignup(contacts);
      window.localStorage.setItem(
        'ews-notification-request',
        JSON.stringify({ ...contacts, createdAt: new Date().toISOString(), mode: result.mode }),
      );

      if (result.mode === 'checkout') {
        setStatus(result.reused ? 'Reopening your existing secure checkout session.' : 'Opening secure checkout.');
        window.location.assign(result.checkoutUrl);
        return;
      }

      setManagementPath(result.managementPath);
      if (result.confirmationPending.length > 0) {
        const channels = result.confirmationPending
          .map((channel) => (channel === 'sms' ? 'text message' : 'email'))
          .join(' and ');
        setStatus(`Subscription saved. Check for a confirmation ${channels} and click the link to activate alerts.`);
      } else {
        setStatus('Notification subscription saved. You will receive takeoff and anomaly alerts.');
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Notification signup failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function enablePushAlerts() {
    setPushError(null);
    setPushStatus(null);
    setPushSubmitting(true);
    try {
      const result = await enableBrowserPushSignup();
      window.localStorage.setItem(
        'ews-browser-push',
        JSON.stringify({ subscriberId: result.id, createdAt: new Date().toISOString(), reused: result.reused }),
      );
      setPushStatus(result.reused ? 'Browser push alerts were already enabled for this device.' : 'Browser push alerts enabled for this device.');
    } catch (pushSignupError) {
      setPushError(pushSignupError instanceof Error ? pushSignupError.message : 'Browser push setup failed.');
    } finally {
      setPushSubmitting(false);
    }
  }

  return (
    <main className="app-shell signup-shell">
      <div className="background-wallpaper" aria-hidden="true" />
      <section className="focus-grid signup-grid">
        <section className="panel hero-copy-panel signup-copy-panel">
          <h1>Apocalypse Notifications</h1>
          <p>Get notified when tracked aircraft become airborne or statistical anomaly thresholds trip.</p>
          <p>
            Email and SMS are double opt-in: after signing up you must click the confirmation link sent to that address or
            number before any alert is ever delivered to it. Contact info is encrypted at rest and used only for alerts and
            your management link.
          </p>
          <p>
            Prefer no personal info at all? Use browser push below, or subscribe to{' '}
            <code>https://ntfy.warning.watch/warning-watch-alerts</code> in the free ntfy app.
          </p>
          <p className="hero-link-row"><a href="/aviation">Back to Aviation</a></p>
        </section>
        <section className="panel signup-panel">
          <h2>Notification Signup</h2>
          {error ? <p className="signup-status signup-status-error">{error}</p> : null}
          {status ? <p className="signup-status signup-status-success">{status}</p> : null}
          {managementPath ? <p className="signup-status"><a href={managementPath}>Manage this subscription</a></p> : null}
          {pushError ? <p className="signup-status signup-status-error">{pushError}</p> : null}
          {pushStatus ? <p className="signup-status signup-status-success">{pushStatus}</p> : null}
          <div className="push-signup-box">
            <h3>Fast browser push</h3>
            <p>Enable device push alerts for takeoff clusters and anomaly spikes. No email, phone number, checkout, or carrier throughput limit required.</p>
            <button className="signup-submit" type="button" disabled={pushSubmitting} onClick={enablePushAlerts}>
              {pushSubmitting ? 'Enabling...' : 'Enable Browser Push'}
            </button>
          </div>
          <form className="signup-form" onSubmit={submit} noValidate>
            <label className="signup-field">
              <span>Email address</span>
              <input type="email" name="email" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.currentTarget.value)} />
            </label>
            <label className="signup-field">
              <span>Phone number</span>
              <input type="tel" name="phone" placeholder="+1 415 555 2671" value={phone} onChange={(event) => {
                const value = event.currentTarget.value;
                setPhone(value);
                if (!value.trim()) setSmsConsent(false);
              }} />
            </label>
            <label className="signup-field checkbox-field">
              <input type="checkbox" name="smsConsent" checked={smsConsent} disabled={!phone.trim()} onChange={(event) => setSmsConsent(event.currentTarget.checked)} />
              <span>I consent to receive Warning Watch SMS alerts at this number. Message and data rates may apply; reply STOP to opt out.</span>
            </label>
            <button className="signup-submit" type="submit" disabled={submitting}>{submitting ? 'Saving...' : 'Sign Up'}</button>
          </form>
        </section>
      </section>
    </main>
  );
}


function ManagePage() {
  const [subscriber, setSubscriber] = useState<ManagedSubscriber | null>(null);
  const [wantsEmail, setWantsEmail] = useState(false);
  const [wantsSms, setWantsSms] = useState(false);
  const [renewSubscription, setRenewSubscription] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const subscriberId = params.get('subscriber') || '';
  const token = params.get('token') || '';

  function applySubscriber(nextSubscriber: ManagedSubscriber) {
    setSubscriber(nextSubscriber);
    setWantsEmail(Boolean(nextSubscriber.wantsEmail));
    setWantsSms(Boolean(nextSubscriber.wantsSms));
    setRenewSubscription(!nextSubscriber.stripeCancelAtPeriodEnd);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError(null);
      setStatus(null);
      if (!subscriberId || !token) {
        setError('Management link is missing a subscriber token.');
        return;
      }
      try {
        const loadedSubscriber = await fetchManagedSubscriber(subscriberId, token);
        if (!cancelled) applySubscriber(loadedSubscriber);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Could not load subscription settings.');
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [subscriberId, token]);

  async function save(action: 'save' | 'delete_account' = 'save', overrides: Partial<Pick<ManagedSubscriber, 'wantsEmail' | 'wantsSms'>> = {}) {
    if (!subscriberId || !token) {
      setError('Management link is missing a subscriber token.');
      return;
    }
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const nextSubscriber = await saveManagedSubscriber({
        subscriber: subscriberId,
        token,
        action,
        wantsEmail: typeof overrides.wantsEmail === 'boolean' ? overrides.wantsEmail : wantsEmail,
        wantsSms: typeof overrides.wantsSms === 'boolean' ? overrides.wantsSms : wantsSms,
        renewSubscription,
      });
      applySubscriber(nextSubscriber);
      setStatus(action === 'delete_account' ? 'Subscription canceled.' : 'Subscription settings saved.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not update subscription settings.');
    } finally {
      setSaving(false);
    }
  }

  const canDeleteAccount = subscriber?.source === 'manual' || subscriber?.source === 'local_api';
  const accountLabel = subscriber?.accountEmail || subscriber?.email || subscriber?.phone || `Subscriber ${subscriber?.id ?? ''}`;

  return (
    <main className="app-shell signup-shell">
      <div className="background-wallpaper" aria-hidden="true" />
      <section className="focus-grid signup-grid">
        <section className="panel hero-copy-panel signup-copy-panel">
          <h1>Manage Notifications</h1>
          <p>Change alert channels, unsubscribe, or manage billing without exposing your contact details publicly.</p>
          <p className="hero-link-row"><a href="/aviation">Back to Aviation</a></p>
        </section>
        <section className="panel signup-panel">
          <h2>Subscription Settings</h2>
          {error ? <p className="signup-status signup-status-error">{error}</p> : null}
          {status ? <p className="signup-status signup-status-success">{status}</p> : null}
          {!subscriber && !error ? <p className="signup-status">Loading subscription settings...</p> : null}
          {subscriber ? (
            <div className="signup-form">
              <p className="signup-status">Managing {accountLabel}. Current status: {subscriber.status}.</p>
              <label className="signup-field checkbox-field">
                <input type="checkbox" checked={wantsEmail} disabled={!subscriber.email || saving} onChange={(event) => setWantsEmail(event.currentTarget.checked)} />
                <span>Email alerts{subscriber.email ? ` to ${subscriber.email}` : ' unavailable'}</span>
              </label>
              <label className="signup-field checkbox-field">
                <input type="checkbox" checked={wantsSms} disabled={!subscriber.phone || saving} onChange={(event) => setWantsSms(event.currentTarget.checked)} />
                <span>SMS alerts{subscriber.phone ? ` to ${subscriber.phone}` : ' unavailable'}</span>
              </label>
              {subscriber.hasStripeSubscription ? (
                <label className="signup-field checkbox-field">
                  <input type="checkbox" checked={renewSubscription} disabled={saving} onChange={(event) => setRenewSubscription(event.currentTarget.checked)} />
                  <span>Renew paid subscription at period end</span>
                </label>
              ) : null}
              <button className="signup-submit" type="button" disabled={saving || (!wantsEmail && !wantsSms)} onClick={() => save('save')}>
                {saving ? 'Saving...' : 'Save Settings'}
              </button>
              <button className="signup-submit secondary-submit" type="button" disabled={saving} onClick={() => save('save', { wantsEmail: false, wantsSms: false })}>
                Unsubscribe from alerts
              </button>
              {canDeleteAccount ? (
                <button className="signup-submit secondary-submit danger-submit" type="button" disabled={saving} onClick={() => save('delete_account')}>
                  Cancel manual subscription
                </button>
              ) : null}
              {subscriber.stripeBillingPortalUrl ? (
                <p className="signup-status"><a href={subscriber.stripeBillingPortalUrl}>Open Stripe billing portal</a></p>
              ) : null}
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}

function combineDashboards(dashboards: LoadedDashboards, selected: SelectedCohorts): CombinedDashboard | null {
  const entries = (Object.keys(CATEGORY_LABELS) as CohortKind[])
    .filter((kind) => selected[kind] && dashboards[kind])
    .map((kind) => ({ kind, dashboard: dashboards[kind]! }));

  if (!entries.length) return null;

  const selectedLabels = entries.map((entry) => CATEGORY_LABELS[entry.kind]);
  const liveAircraft = entries.flatMap((entry) =>
    (entry.dashboard.liveAircraft ?? []).map((aircraft, index) => ({
      ...aircraft,
      cohortKind: entry.kind,
      markerId: `${entry.kind}:${aircraft.hex ?? aircraft.registration ?? aircraft.label ?? index}`,
    })),
  );
  const archives = entries.map((entry) => decodeArchive(entry.dashboard.trends?.archive));
  const archive = entries.length === 1 ? archives[0] : combineArchives(archives);
  const trackedCounts = entries.map((entry) => entry.dashboard.cohort?.trackedCount).filter((value): value is number => Number.isFinite(value));
  const trackedCount = trackedCounts.length === entries.length ? trackedCounts.reduce((sum, value) => sum + value, 0) : null;

  const actualCount = entries.reduce((sum, entry) => sum + finiteNumber(entry.dashboard.current?.concurrentCount ?? entry.dashboard.signals?.composite?.actualConcurrentCount, 0), 0);
  const expectedCount = entries.reduce((sum, entry) => sum + finiteNumber(entry.dashboard.current?.baselineMean ?? entry.dashboard.signals?.composite?.expectedConcurrentCount, 0), 0);
  const stdDev = Math.sqrt(entries.reduce((sum, entry) => {
    const value = finiteNumber(entry.dashboard.current?.baselineStdDev ?? entry.dashboard.signals?.composite?.expectedConcurrentStdDev, 0);
    return sum + value * value;
  }, 0));

  const archiveScale = archiveDistribution(archive);
  const alarmSigmaThreshold = entries.length === 1
    ? finiteNumber(entries[0].dashboard.current?.alarmSigmaThreshold ?? entries[0].dashboard.signals?.composite?.alarmSigmaThreshold, DEFAULT_ALARM_SIGMA)
    : calibrateAlarmThreshold(archive);
  const singleCurrent = entries.length === 1 ? entries[0].dashboard.current : undefined;
  const singleComposite = entries.length === 1 ? entries[0].dashboard.signals?.composite : undefined;
  const computed = singleComposite ? null : computeSignal(actualCount, expectedCount, stdDev, alarmSigmaThreshold, archiveScale);
  const signal: CurrentSignal & SignalMath = singleComposite
    ? {
        ...(singleCurrent ?? {}),
        concurrentCount: finiteNumber(singleComposite.actualConcurrentCount, actualCount),
        baselineMean: finiteNumber(singleComposite.expectedConcurrentCount, expectedCount),
        baselineStdDev: finiteNumber(singleComposite.expectedConcurrentStdDev, stdDev),
        divergence: actualCount - expectedCount,
        effectiveBaselineStdDev: finiteNumber(singleComposite.effectiveConcurrentStdDev, stdDev),
        sigmaShift: finiteNumber(singleComposite.sigmaShift, 0),
        rawSigmaShift: finiteNumber(singleComposite.rawSigmaShift, 0),
        varianceAdjustedSigmaShift: finiteNumber(singleComposite.varianceAdjustedSigmaShift, 0),
        zScore: finiteNumber(singleComposite.sigmaShift, 0),
        rawZScore: finiteNumber(singleComposite.rawSigmaShift, 0),
        varianceAdjustedZScore: finiteNumber(singleComposite.varianceAdjustedSigmaShift, 0),
        absoluteExcessWeight: finiteNumber(singleComposite.absoluteExcessWeight, 0),
        gaugeValue: singleComposite.gaugeValue,
        emergencyLevel: finiteNumber(singleComposite.emergencyLevel, 1),
        alarmSigmaThreshold,
      }
    : {
        ...computed!,
        concurrentCount: actualCount,
        baselineMean: expectedCount,
        baselineStdDev: stdDev,
        effectiveBaselineStdDev: computed!.effectiveBaselineStdDev,
        zScore: computed!.sigmaShift,
        rawZScore: computed!.rawSigmaShift,
        varianceAdjustedZScore: computed!.varianceAdjustedSigmaShift,
        emergencyLevel: computed!.emergencyLevel,
        alarmSigmaThreshold,
      };

  const primary = entries[0].dashboard;
  const measurementTimes = entries.map((entry) =>
    Date.parse(entry.dashboard.current?.asOf ?? entry.dashboard.liveStatus?.latestSampledAt ?? ''));
  const allSelectedPresent = entries.length === Object.values(selected).filter(Boolean).length;
  const asOf = allSelectedPresent && measurementTimes.every((time) => Number.isFinite(time) && time <= Date.now() + 60000)
    ? new Date(Math.min(...measurementTimes)).toISOString() : undefined;
  const assessmentProblem = !allSelectedPresent ? 'Data for a selected cohort is unavailable.'
    : entries.some(({ dashboard }) => (dashboard.current?.modelReady ?? dashboard.signals?.composite?.modelReady) !== true)
      ? 'A selected cohort does not have a ready baseline.'
      : asOf && Math.max(...measurementTimes) - Math.min(...measurementTimes) > 60000
        ? 'Selected cohorts belong to different source slots. A combined current signal is unavailable.' : undefined;
  const holidayWindows = dedupeHolidayWindows(entries.flatMap((entry) => entry.dashboard.trends?.holidayWindows ?? []));
  const providerStatus = entries.map((entry) => {
    const live = entry.dashboard.liveStatus;
    const last = live?.lastSuccessAt ? formatDateTime(live.lastSuccessAt) : 'not reported';
    const matched = live?.matchedCount == null ? 'unknown matches' : `${formatInteger(live.matchedCount)} matches`;
    return `${CATEGORY_LABELS[entry.kind]}: ${live?.providerLabel ?? 'provider unknown'}, ${matched}, last success ${last}`;
  }).join(' · ');
  const providerWarnings = entries.flatMap((entry) => {
    const live = entry.dashboard.liveStatus;
    const warnings: string[] = [];
    if (live?.lastError) {
      warnings.push(`${CATEGORY_LABELS[entry.kind]} provider error: ${live.lastError}`);
    }
    const sampledAt = Date.parse(live?.latestSampledAt || '');
    if (!Number.isFinite(sampledAt) || sampledAt > Date.now() + 60000 || Date.now() - sampledAt > STALE_AFTER_MINUTES * 60000) {
      warnings.push(`${CATEGORY_LABELS[entry.kind]} ADS-B data is stale or has an invalid timestamp.`);
    }
    return warnings;
  });

  const aircraftForModelSummary = liveAircraft.filter((plane) => plane.cohortKind !== 'untracked');
  const aircraftForSeatEstimate = liveAircraft.filter((plane) => plane.cohortKind === 'business');

  return {
    selectedKinds: entries.map((entry) => entry.kind),
    selectedLabels,
    primary,
    liveAircraft,
    archive: decorateArchiveLevels(archive, alarmSigmaThreshold),
    holidayWindows,
    trackedCount,
    actualCount,
    assessmentProblem,
    expectedCount,
    stdDev,
    alarmSigmaThreshold,
    providerWarning: providerWarnings[0] ?? null,
    signal,
    asOf,
    providerStatus,
    modelCounts: countModels(aircraftForModelSummary),
    seats: estimateSeats(aircraftForSeatEstimate),
  };
}

function decodeArchive(input: PackedArchive | ArchivePoint[] | undefined): ArchivePoint[] {
  if (Array.isArray(input)) return input.map(normalizeArchivePoint);
  if (!input || input.v !== 1 || !Array.isArray(input.c)) return [];
  const sampledAt = expandTimes(input.t0, input.tr);
  const length = Math.max(sampledAt.length, input.c.length, input.p?.length ?? 0, input.s?.length ?? 0, input.z?.length ?? 0);
  return Array.from({ length }, (_, index) => normalizeArchivePoint({
    sampledAt: sampledAt[index],
    concurrentCount: input.c?.[index],
    predictedConcurrentCount: input.p?.[index],
    predictedConcurrentStdDev: input.s?.[index],
    sigmaShift: input.z?.[index],
  }));
}

function expandTimes(t0: string, transitions: [number, number][] | undefined): string[] {
  const start = Date.parse(t0);
  if (!Number.isFinite(start)) return [];
  const result = [new Date(start).toISOString()];
  let current = start;
  for (const transition of transitions ?? []) {
    const [deltaMs, repeatCount] = transition;
    for (let index = 0; index < repeatCount; index += 1) {
      current += deltaMs;
      result.push(new Date(current).toISOString());
    }
  }
  return result;
}

function normalizeArchivePoint(point: ArchivePoint): ArchivePoint {
  const concurrentCount = finiteNumber(point.concurrentCount, 0);
  const predictedConcurrentCount = finiteNumber(point.predictedConcurrentCount, 0);
  const predictedConcurrentStdDev = finiteNumber(point.predictedConcurrentStdDev, 0);
  const divergence = finiteNumber(point.divergence, concurrentCount - predictedConcurrentCount);
  const sigmaShift = finiteNumber(point.sigmaShift, predictedConcurrentStdDev ? divergence / predictedConcurrentStdDev : 0);
  return { ...point, concurrentCount, predictedConcurrentCount, predictedConcurrentStdDev, divergence, sigmaShift };
}

function combineArchives(archives: ArchivePoint[][]): ArchivePoint[] {
  if (!archives.length || archives.some((archive) => archive.length === 0)) return [];
  const maps = archives.map((archive) => new Map(archive.map((point) => [roundSlot(point.sampledAt), point]).filter(([key]) => key) as Array<[string, ArchivePoint]>));
  return Array.from(maps[0].keys())
    .filter((key) => maps.every((map) => map.has(key)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .map((sampledAt) => {
      const points = maps.map((map) => map.get(sampledAt)!);
      const concurrentCount = points.reduce((sum, point) => sum + finiteNumber(point.concurrentCount, 0), 0);
      const predictedConcurrentCount = points.reduce((sum, point) => sum + finiteNumber(point.predictedConcurrentCount, 0), 0);
      const predictedConcurrentStdDev = Math.sqrt(points.reduce((sum, point) => sum + finiteNumber(point.predictedConcurrentStdDev, 0) ** 2, 0));
      return normalizeArchivePoint({ sampledAt, concurrentCount, predictedConcurrentCount, predictedConcurrentStdDev });
    });
}

function roundSlot(sampledAt: string | undefined): string | null {
  const time = Date.parse(sampledAt ?? '');
  if (!Number.isFinite(time)) return null;
  return new Date(Math.round(time / HALF_HOUR_MS) * HALF_HOUR_MS).toISOString();
}

function archiveDistribution(points: ArchivePoint[]) {
  const divergences: number[] = [];
  const positiveDivergences: number[] = [];
  const stdDevs: number[] = [];
  for (const point of points) {
    const divergence = finiteNumber(point.concurrentCount, 0) - finiteNumber(point.predictedConcurrentCount, 0);
    const stdDev = finiteNumber(point.predictedConcurrentStdDev, 0);
    if (Number.isFinite(divergence)) {
      divergences.push(Math.abs(divergence));
      if (divergence > 0) positiveDivergences.push(divergence);
    }
    if (stdDev > 0) stdDevs.push(stdDev);
  }
  const stdDevFloor = median(divergences.filter((value) => value > 0)) ?? median(stdDevs) ?? 0;
  return { stdDevFloor, positiveExcessScale: median(positiveDivergences) ?? stdDevFloor };
}

function computeSignal(actual: number, expected: number, stdDev: number, alarmSigmaThreshold: number, scale: { stdDevFloor?: number; positiveExcessScale?: number }): SignalMath {
  const divergence = actual - expected;
  const effectiveBaselineStdDev = Math.max(stdDev, finiteNumber(scale.stdDevFloor, 0));
  if (!effectiveBaselineStdDev) {
    return { divergence, sigmaShift: 0, rawSigmaShift: 0, varianceAdjustedSigmaShift: 0, effectiveBaselineStdDev: 0, absoluteExcessWeight: 1, emergencyLevel: 1 };
  }
  const rawSigmaShift = stdDev ? divergence / stdDev : 0;
  const varianceAdjustedSigmaShift = divergence / effectiveBaselineStdDev;
  const positiveExcessScale = finiteNumber(scale.positiveExcessScale, 0);
  const absoluteExcessWeight = divergence > 0 && positiveExcessScale > 0 ? divergence / (divergence + positiveExcessScale) : 1;
  const sigmaShift = varianceAdjustedSigmaShift > 0 ? varianceAdjustedSigmaShift * absoluteExcessWeight : varianceAdjustedSigmaShift;
  const emergencyLevel = Math.min(LEVEL_COUNT, Math.max(1, Math.floor((Math.max(0, sigmaShift) / Math.max(1, alarmSigmaThreshold)) * (LEVEL_COUNT - 1)) + 1));
  return { divergence, sigmaShift, rawSigmaShift, varianceAdjustedSigmaShift, effectiveBaselineStdDev, absoluteExcessWeight, emergencyLevel };
}

function decorateArchiveLevels(points: ArchivePoint[], threshold: number): ArchivePoint[] {
  return points.map((point) => ({ ...point, emergencyLevel: pointToEmergencyLevel(point, threshold) }));
}

function pointToEmergencyLevel(point: ArchivePoint, threshold: number): number {
  const sigma = finiteNumber(point.sigmaShift, 0);
  return Math.min(LEVEL_COUNT, Math.max(1, Math.floor((Math.max(0, sigma) / Math.max(1, threshold)) * (LEVEL_COUNT - 1)) + 1));
}

function calibrateAlarmThreshold(points: ArchivePoint[]): number {
  if (!points.length) return DEFAULT_ALARM_SIGMA;
  const cutoff = Date.parse(points.at(-1)?.sampledAt ?? '') - 365 * DAY_MS;
  const byDay = new Map<string, number>();
  for (const point of points) {
    const time = Date.parse(point.sampledAt ?? '');
    if (!Number.isFinite(time) || time < cutoff) continue;
    const day = point.sampledAt!.slice(0, 10);
    byDay.set(day, Math.max(byDay.get(day) ?? Number.NEGATIVE_INFINITY, finiteNumber(point.sigmaShift, 0)));
  }
  const dailyMax = Array.from(byDay.values()).sort((a, b) => b - a);
  if (!dailyMax.length) return DEFAULT_ALARM_SIGMA;
  if (dailyMax.length === 1) return Math.max(DEFAULT_ALARM_SIGMA, Math.ceil(dailyMax[0] * 10) / 10);
  return Math.max(DEFAULT_ALARM_SIGMA, Math.ceil((dailyMax[1] + 0.05) * 10) / 10);
}

function dedupeHolidayWindows(windows: HolidayWindow[]): HolidayWindow[] {
  const seen = new Map<string, HolidayWindow>();
  for (const window of windows) {
    const key = [window.id, window.startsAt, window.endsAt].filter(Boolean).join('|');
    if (key && !seen.has(key)) seen.set(key, window);
  }
  return Array.from(seen.values()).sort((a, b) => Date.parse(a.startsAt ?? '') - Date.parse(b.startsAt ?? ''));
}

function countModels(aircraft: Aircraft[]): ModelCount[] {
  const counts = new Map<string, number>();
  for (const plane of aircraft) {
    const label = normalizeModelLabel(plane.label ?? plane.registration ?? plane.hex ?? 'Unknown');
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count, capacity: capacityForModel(label), wiki: wikiForModel(label) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function estimateSeats(aircraft: Aircraft[]): SeatEstimate {
  const capacities = aircraft.map((plane) => capacityForModel(plane.label ?? '')).filter((capacity): capacity is number => capacity != null);
  const knownSeats = capacities.reduce((sum, value) => sum + value, 0);
  const knownAircraftCount = capacities.length;
  const totalAircraftCount = aircraft.length;
  const estimatedSeats = knownAircraftCount ? Math.round(knownSeats + (totalAircraftCount - knownAircraftCount) * (knownSeats / knownAircraftCount)) : null;
  return { knownAircraftCount, totalAircraftCount, knownSeats, estimatedSeats };
}

const CAPACITY_PATTERNS: Array<[RegExp, number, string?]> = [
  [/A320|BOEING 737|B737|767|BAE 146/i, 180],
  [/GLOBAL|BD-700|G650|GVI|GVII|G550|GV-SP|G600/i, 19, 'https://en.wikipedia.org/wiki/Gulfstream_G650'],
  [/FALCON 7X|FALCON 8X/i, 16, 'https://en.wikipedia.org/wiki/Dassault_Falcon_7X'],
  [/FALCON 2000|FALCON 900/i, 10, 'https://en.wikipedia.org/wiki/Dassault_Falcon_2000'],
  [/CHALLENGER|BD-100|CL-600|CANADAIR/i, 10, 'https://en.wikipedia.org/wiki/Bombardier_Challenger_300'],
  [/CITATION LATITUDE|680A|CITATION SOVEREIGN|\b680\b/i, 9, 'https://en.wikipedia.org/wiki/Cessna_Citation_Latitude'],
  [/560XL|CITATION XLS|CITATION EXCEL/i, 10, 'https://en.wikipedia.org/wiki/Cessna_Citation_Excel'],
  [/CESSNA 525|CITATIONJET|CJ2|CJ3|CJ4|M2/i, 7, 'https://en.wikipedia.org/wiki/Cessna_CitationJet/M2'],
  [/PHENOM 300|EMB-505/i, 10, 'https://en.wikipedia.org/wiki/Embraer_Phenom_300'],
  [/PRAETOR|EMB-550|EMB-545|LEGACY/i, 12, 'https://en.wikipedia.org/wiki/Embraer_Praetor_500/600'],
  [/PC-24/i, 10, 'https://en.wikipedia.org/wiki/Pilatus_PC-24'],
  [/HONDA|HA-420/i, 6, 'https://en.wikipedia.org/wiki/Honda_HA-420_HondaJet'],
  [/HAWKER|BEECHJET|400A|400XT/i, 8, 'https://en.wikipedia.org/wiki/Beechcraft_400'],
  [/LEARJET 75|LEARJET 60|LEARJET 45|LEARJET/i, 8, 'https://en.wikipedia.org/wiki/Learjet_45'],
  [/CIRRUS|SF50|VISION/i, 5, 'https://en.wikipedia.org/wiki/Cirrus_Vision_SF50'],
];

function capacityForModel(label: string): number | null {
  return CAPACITY_PATTERNS.find(([pattern]) => pattern.test(label))?.[1] ?? null;
}

function wikiForModel(label: string): string | undefined {
  return CAPACITY_PATTERNS.find(([pattern]) => pattern.test(label))?.[2];
}

function normalizeModelLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim() || 'Unknown';
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampLevel(value: unknown): number {
  return Math.min(LEVEL_COUNT, Math.max(1, Math.round(finiteNumber(value, 1))));
}

function isFiniteCoordinate(lat: unknown, lon: unknown): lat is number {
  const parsedLat = Number(lat);
  const parsedLon = Number(lon);
  return Number.isFinite(parsedLat) && Number.isFinite(parsedLon) && parsedLat >= -90 && parsedLat <= 90 && parsedLon >= -180 && parsedLon <= 180;
}

function project(lon: number, lat: number, width: number, height: number) {
  return { x: ((lon + 180) / 360) * width, y: ((90 - lat) / 180) * height };
}

function makeDateTicks(data: ArchivePoint[], count: number) {
  if (!data.length) return [];
  return Array.from({ length: count }, (_, tickIndex) => {
    const index = Math.round((tickIndex / Math.max(1, count - 1)) * (data.length - 1));
    return { index, label: formatShortDate(data[index]?.sampledAt) };
  });
}

function formatInteger(value: number) {
  return Math.round(value).toLocaleString();
}

function formatNumber(value: number, digits = 0) {
  return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatSigned(value: number, digits = 0) {
  const rounded = Number(value.toFixed(digits));
  return `${rounded >= 0 ? '+' : ''}${rounded.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
}

function formatNullableNumber(value: unknown, digits = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? formatNumber(parsed, digits) : '—';
}

function formatAxis(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return 'not reported';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
}

function formatShortDate(value: string | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

export default App;
