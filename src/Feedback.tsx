import { FormEvent, useEffect, useRef, useState } from 'react';

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

export default function FeedbackWidget() {
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
