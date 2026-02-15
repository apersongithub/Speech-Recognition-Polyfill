// content.js - Firefox MV2
// Fix for "fake enter" not recognized:
// - Prefer submitting the closest form via requestSubmit() (works on GitHub search, many React apps)
// - Fall back to form.submit() or synthetic Enter only if needed.
// - Debug mode: can mirror background debug logs into the *site's* console.

const IS_TOP_FRAME = (window.self === window.top);
if (!IS_TOP_FRAME) {
  // Do not throw in iframes (Google Docs/Slides rely on them).
  // Just don't initialize Whisper in iframes.
}

const MIC_GAIN_MIN = 1.0;
const MIC_GAIN_MAX = 3.0;
const MIC_GAIN_DEFAULT = 1.0;

const SILENCE_SENSITIVITY_MIN = 6;
const SILENCE_SENSITIVITY_MAX = 20;
const SILENCE_SENSITIVITY_DEFAULT = 12;

const STREAM_TARGET_SAMPLE_RATE = 16000;
const STREAM_CHUNK_MS = 250;
const STREAM_CHUNK_SAMPLES = Math.round(STREAM_TARGET_SAMPLE_RATE * STREAM_CHUNK_MS / 1000);
// Try these values (content.js)
const STREAM_IDLE_TIMEOUT_MS = 15000; // or even 30000
const STREAM_EARLY_STOP_GUARD_MS = 4500; // NEW: ignore premature UI stop on Duolingo

let streamingEverHeard = false; // NEW: track if we detected any speech during streaming
let silenceTimeoutMs = 1000; // Experiment: 5–10s
let shouldShowNotifications = false;
let debugLogsEnabled = false;
let captureActive = false;
let currentSessionId = 0;
let activeSessionId = 0;

let processingSessionId = null;
let disableHardCap = false;

let hotkey = 'Alt+A';
let normalizedHotkey = null;
let shortcutEnabled = true;
let sendEnterAfterResult = false;

let globalStream = null;
let globalContext = null;
let globalRecorder = null;
let globalChunks = [];
let skipTranscribe = false;
let silenceCheckTimer = null;

let debugLogToSiteConsole = false;

// per-site enabled
let extensionEnabledForSite = true;

// dev options
let stripTrailingPeriod = false;
let micGain = MIC_GAIN_DEFAULT;
let silenceSensitivity = SILENCE_SENSITIVITY_DEFAULT;
let streamingSilenceMode = 'partial';
let disableSpaceNormalization = false;

// NEW: disable processing timeouts
let disableProcessingTimeouts = false;

let streamingProvider = null; // 'assemblyai' | 'vosk' | null
let streamingActive = false;

// AssemblyAI streaming
let assemblyaiStreamingEnabled = false;
let streamingProcessor = null;
let streamingGain = null;
let streamingBuffers = [];
let streamingBufferSamples = 0;
let streamingSessionId = null;
let streamingCaptureActive = false;

// NEW: prevent multiple final submissions per Duolingo session
let handledStreamingFinalSessionId = null;

// watchdog
let processingWatchdog = null;
const PROCESSING_WATCHDOG_MS = 22000;

// NEW: lock insertion target per session
let lockedInsertTarget = null;
let lockedInsertTargetInfo = null;

// NEW: page-bridge ack tracking (duplicate-text fix)
let pendingPageAck = null; // { sessionId, timer, resolve }
const PAGE_ACK_TIMEOUT_MS = 220;

// NEW: recording-start watchdog to prevent "Listening..." desync
let startRecordingWatchdog = null;
const START_RECORDING_WATCHDOG_MS = 1200;

let nextStartSource = null;
let currentStartSource = 'ui';

let lastSpeechActive = false;
let lastAudioActive = false;

const STREAMING_FINAL_STABILITY_MS = 250; // NEW: wait briefly for matching partial

let lastStreamingPartialText = null; // NEW
let lastStreamingPartialSessionId = null; // NEW
let pendingStreamingFinal = null; // NEW: { sessionId, text, timer }

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

function armProcessingWatchdog(sessionId) {
  if (disableProcessingTimeouts) return;
  clearProcessingWatchdog();
  processingWatchdog = setTimeout(() => {
    dbg('Processing watchdog fired', { sessionId, processingSessionId });
    processingSessionId = null;
    showNotification("Transcription timed out. Please try again.", "error");
  }, PROCESSING_WATCHDOG_MS);
}

function sendStreamingChunk(chunk) {
  if (!streamingSessionId) return;

  if (streamingProvider === 'assemblyai') {
    const pcm = floatTo16BitPCM(chunk);
    try {
      browser.runtime.sendMessage({
        type: 'ASSEMBLYAI_STREAM_CHUNK',
        sessionId: streamingSessionId,
        audioData: pcm.buffer,
        hostname: location.hostname,
        pageInstanceId: PAGE_INSTANCE_ID
      });
    } catch (_) { }
    return;
  }

  if (streamingProvider === 'vosk') {
    // ✅ send ONLY the chunk slice, not the full buffer
    const slice = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    try {
      browser.runtime.sendMessage({
        type: 'VOSK_STREAM_CHUNK',
        sessionId: streamingSessionId,
        audioData: slice,
        sampleRate: STREAM_TARGET_SAMPLE_RATE,
        hostname: location.hostname,
        pageInstanceId: PAGE_INSTANCE_ID
      });
    } catch (_) { }
  }
}

function normalizeStreamingText(s) {
  return (s || '').trim().replace(/\s+/g, ' ');
}

function needsLeadingSpace(prevChar, nextText) {
  if (!prevChar) return false;
  if (disableSpaceNormalization) return false;

  const prev = String(prevChar);
  const next = String(nextText || '');

  if (/[\s\(\[\{'"“‘]$/.test(prev)) return false;
  if (/^[\s\.,!?;:\)\]\}'"”’]/.test(next)) return false;

  return true;
}

function getPrevCharFromTarget(target) {
  if (!target) return '';

  const tag = (target.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'input') {
    try {
      const pos = typeof target.selectionStart === 'number' ? target.selectionStart : null;
      if (pos && pos > 0) return target.value?.charAt(pos - 1) || '';
    } catch (_) { }
    return '';
  }

  if (target.isContentEditable) {
    try {
      const sel = window.getSelection?.();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        const offset = range.startOffset;
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent || '';
          if (offset > 0) return text.charAt(offset - 1);
        }
      }
    } catch (_) { }
  }

  return '';
}

function normalizeInsertText(target, text) {
  if (!text) return text;
  const prevChar = getPrevCharFromTarget(target);
  if (needsLeadingSpace(prevChar, text)) return ' ' + text;
  return text;
}

function clearPendingStreamingFinal() {
  if (pendingStreamingFinal?.timer) {
    try { clearTimeout(pendingStreamingFinal.timer); } catch (_) { }
  }
  pendingStreamingFinal = null;
}

function clearStartRecordingWatchdog() {
  if (startRecordingWatchdog) {
    try { clearTimeout(startRecordingWatchdog); } catch (_) { }
    startRecordingWatchdog = null;
  }
}

function clearPendingPageAck() {
  if (pendingPageAck?.timer) {
    try { clearTimeout(pendingPageAck.timer); } catch (_) { }
  }
  pendingPageAck = null;
}

function waitForPageHandledAck(sessionId) {
  // One pending ack at a time is enough (results are serialized per tab/session).
  clearPendingPageAck();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Timed out => treat as "page did not handle"
      if (pendingPageAck && pendingPageAck.sessionId === sessionId) pendingPageAck = null;
      resolve(false);
    }, PAGE_ACK_TIMEOUT_MS);

    pendingPageAck = { sessionId, timer, resolve };
  });
}

function forceEndPageRecognition() {
  try { window.postMessage({ type: 'WHISPER_FORCE_END' }, "*"); } catch (_) { }
}

function setAudioActive(active) {
  if (!IS_TOP_FRAME) return;
  if (lastAudioActive === active) return;
  lastAudioActive = active;
  window.postMessage({ type: active ? 'WHISPER_AUDIO_START' : 'WHISPER_AUDIO_END' }, "*");
}

function setSpeechActive(active) {
  if (!IS_TOP_FRAME) return;
  if (lastSpeechActive === active) return;
  lastSpeechActive = active;
  window.postMessage({ type: active ? 'WHISPER_SPEECH_START' : 'WHISPER_SPEECH_END' }, "*");
}

function pushPageConfig() {
  if (!IS_TOP_FRAME) return;
  window.postMessage({
    type: 'WHISPER_CONFIG',
    disableSpaceNormalization: !!disableSpaceNormalization,
    streamingActive: !!streamingActive
  }, "*");
}

// Listen for page ack from polyfill/page script
window.addEventListener('message', (e) => {
  if (!IS_TOP_FRAME) return;
  if (!e?.data || e.data.type !== 'WHISPER_PAGE_HANDLED') return;

  if (pendingPageAck?.resolve) {
    const r = pendingPageAck.resolve;
    clearPendingPageAck();
    r(true);
  }
});

function isGoogleDocsOrSlidesHost() {
  const h = (location.hostname || '').toLowerCase();
  return h === 'docs.google.com' || h === 'slides.google.com';
}

// NEW: docs.google.com-only workaround.
function isDocsHost() {
  return (location.hostname || '').toLowerCase() === 'docs.google.com';
}

function isDuolingoHost() {
  const h = (location.hostname || '').toLowerCase();
  return h === 'www.duolingo.com' || h.endsWith('.duolingo.com') || h === 'www.duolingo.cn' || h.endsWith('.duolingo.cn');
}

function isMacOS() {
  return /\bMac\b/i.test(navigator.platform || '') || /\bMacintosh\b/i.test(navigator.userAgent || '');
}

function dispatchSyntheticKeySequence(target, init) {
  try {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, ...init });
      target.dispatchEvent(ev);
    }
    return true;
  } catch (_) {
    return false;
  }
}

function docsDispatchCtrlMetaShiftS() {
  const mac = isMacOS();
  const init = {
    key: 'S',
    code: 'KeyS',
    keyCode: 83,
    which: 83,
    shiftKey: true,
    ctrlKey: !mac,
    metaKey: mac,
    altKey: false,
    bubbles: true,
    cancelable: true
  };

  const payload = JSON.stringify(init);

  const script = document.createElement('script');
  script.textContent = `
    (function() {
      const init = ${payload};
      document.body.dispatchEvent(new KeyboardEvent('keydown', init));
      document.body.dispatchEvent(new KeyboardEvent('keypress', init));
      document.body.dispatchEvent(new KeyboardEvent('keyup', init));
    })();
  `;
  (document.head || document.documentElement).appendChild(script);
  script.remove();

  dbg('docs_ctrl_meta_shift_s_dispatched', { injected: true, mac });
  return true;
}

function tryExecCommandInsert(text) {
  try {
    // returns false if the command is unsupported/blocked
    return document.execCommand && document.execCommand('insertText', false, text);
  } catch (_) {
    return false;
  }
}

function clampMicGain(val) {
  const n = parseFloat(val);
  if (Number.isNaN(n)) return MIC_GAIN_DEFAULT;
  return Math.max(MIC_GAIN_MIN, Math.min(MIC_GAIN_MAX, n));
}

function clampSilenceSensitivity(val) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return SILENCE_SENSITIVITY_DEFAULT;
  return Math.max(SILENCE_SENSITIVITY_MIN, Math.min(SILENCE_SENSITIVITY_MAX, n));
}

function dbg(...args) {
  if (!debugLogsEnabled) return;
  console.log('[Whisper DEBUG]', ...args);
}

function dbgSite(tag, data) {
  if (!debugLogToSiteConsole) return;
  try { console.debug('[Whisper BG]', tag, data || {}); } catch (_) { }
}

function clearProcessingWatchdog() {
  if (processingWatchdog) {
    clearTimeout(processingWatchdog);
    processingWatchdog = null;
  }
}

function armProcessingWatchdog(sessionId) {
  clearProcessingWatchdog();
  processingWatchdog = setTimeout(() => {
    dbg('Processing watchdog fired', { sessionId, processingSessionId });
    processingSessionId = null;
    showNotification("Transcription timed out. Please try again.", "error");
  }, PROCESSING_WATCHDOG_MS);
}

function normalizeHotkey(combo) {
  if (!combo || typeof combo !== 'string') return null;
  const parts = combo.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
  const mods = { alt: false, ctrl: false, meta: false, shift: false };
  let key = null;
  for (const p of parts) {
    if (p === 'alt' || p === 'option') mods.alt = true;
    else if (p === 'ctrl' || p === 'control') mods.ctrl = true;
    else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'super' || p === 'win') mods.meta = true;
    else if (p === 'shift') mods.shift = true;
    else if (!key) key = p;
  }
  if (!key) return null;
  return { key, ...mods };
}

function isHotkeyEvent(e) {
  if (!normalizedHotkey) return false;
  const key = (e.key || '').toLowerCase();
  return key === normalizedHotkey.key &&
    e.altKey === !!normalizedHotkey.alt &&
    e.ctrlKey === !!normalizedHotkey.ctrl &&
    e.metaKey === !!normalizedHotkey.meta &&
    e.shiftKey === !!normalizedHotkey.shift;
}

function isEditableTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'textarea') return !el.disabled && !el.readOnly;
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    const okTypes = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number']);
    if (!okTypes.has(type)) return false;
    return !el.disabled && !el.readOnly;
  }
  if (el.isContentEditable) return true;
  return false;
}

function findEditableFromEvent(e) {
  const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
  for (const node of path) {
    if (node && node.nodeType === 1 && isEditableTarget(node)) return node;
  }
  if (isEditableTarget(e.target)) return e.target;
  const a = document.activeElement;
  if (isEditableTarget(a)) return a;
  return null;
}

function findActiveEditable() {
  const a = document.activeElement;
  if (isEditableTarget(a)) return a;

  const sel = window.getSelection?.();
  const anchor = sel?.anchorNode;
  let el = anchor && anchor.nodeType === 1 ? anchor : anchor?.parentElement;
  while (el) {
    if (el.isContentEditable) return el;
    el = el.parentElement;
  }
  return null;
}

function snapshotTargetInfo(el) {
  if (!el || el.nodeType !== 1) return null;
  const tag = (el.tagName || '').toLowerCase();
  const info = {
    tag,
    isContentEditable: !!el.isContentEditable,
    id: el.id || null,
    name: el.getAttribute?.('name') || null,
    ariaLabel: el.getAttribute?.('aria-label') || null,
    className: (typeof el.className === 'string') ? el.className : null
  };

  if (tag === 'textarea' || tag === 'input') {
    try {
      info.selectionStart = typeof el.selectionStart === 'number' ? el.selectionStart : null;
      info.selectionEnd = typeof el.selectionEnd === 'number' ? el.selectionEnd : null;
    } catch (_) {
      info.selectionStart = null;
      info.selectionEnd = null;
    }
  }
  return info;
}

function lockInsertionTargetFromEvent(e) {
  const candidate = findEditableFromEvent(e) || findActiveEditable();
  if (candidate && isEditableTarget(candidate)) {
    lockedInsertTarget = candidate;
    lockedInsertTargetInfo = snapshotTargetInfo(candidate);
  } else {
    lockedInsertTarget = null;
    lockedInsertTargetInfo = null;
  }
}

function clearLockedInsertionTarget() {
  lockedInsertTarget = null;
  lockedInsertTargetInfo = null;
}

function normalizeHost(hostname) {
  if (!hostname) return '';
  let host = String(hostname).trim().toLowerCase();

  // If caller passed a full URL, extract hostname
  try {
    if (host.includes('://') || host.includes('/')) {
      host = new URL(host).hostname.toLowerCase();
    }
  } catch (_) { /* leave host as-is on parse failure */ }

  // Remove optional port if present (example.com:8080 -> example.com)
  host = host.replace(/:\d+$/, '');

  // Do not strip "www." anymore — keep host exactly as provided.
  return host;
}

function hostMatchesRule(host, ruleHost) {
  if (!host || !ruleHost) return false;
  if (host === ruleHost) return true;
  return host.endsWith('.' + ruleHost);
}

// Robust provider lookup: handles normalized hosts and rule matches (www/ports, wildcard subhosts)
function getProviderFromSettings(settings, hostname) {
  const defaults = settings?.defaults || {};
  const overrides = settings?.overrides || {};

  // Accept either a full hostname or a value that may already be normalized
  const host = normalizeHost(hostname);

  // Resolve site override using exact match first, then rule matching (example.com → matches www.example.com)
  let site = {};
  if (host && overrides[host]) {
    site = overrides[host];
  } else if (host) {
    for (const [ruleHost, cfg] of Object.entries(overrides)) {
      if (hostMatchesRule(host, normalizeHost(ruleHost))) {
        site = cfg;
        break;
      }
    }
  }

  const baseProvider = (defaults.provider === 'assemblyai')
    ? 'assemblyai'
    : (defaults.provider === 'local-whisper')
      ? 'local-whisper'
      : 'vosk';

  const chosen = (site?.provider ?? baseProvider);
  if (chosen === 'assemblyai') return 'assemblyai';
  if (chosen === 'vosk') return 'vosk';
  return 'local-whisper';
}

function normalizeStreamingSilenceMode(mode) {
  if (mode === 'always' || mode === 'never' || mode === 'partial') return mode;
  return 'partial';
}

function shouldApplyStreamingSilenceTimeout() {
  if (!streamingActive) return false;

  // Apply the SAME silence-mode rules for all streaming providers (vosk + assemblyai)
  if (streamingSilenceMode === 'always') return true;
  if (streamingSilenceMode === 'never') return false;

  // "partial" => only when started by site UI, not hotkey
  return currentStartSource === 'ui';
}

function resetStreamingBuffers() {
  streamingBuffers = [];
  streamingBufferSamples = 0;
}

function mergeFloat32(buffers, totalLength) {
  const out = new Float32Array(totalLength);
  let offset = 0;
  for (const b of buffers) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

function resampleTo16k(buffer, inputSampleRate) {
  if (inputSampleRate === STREAM_TARGET_SAMPLE_RATE) return buffer;
  const ratio = inputSampleRate / STREAM_TARGET_SAMPLE_RATE;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offset = 0;
  for (let i = 0; i < newLength; i++) {
    const nextOffset = Math.min(buffer.length, Math.round((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = offset; j < nextOffset; j++) {
      sum += buffer[j];
      count += 1;
    }
    result[i] = count ? sum / count : 0;
    offset = nextOffset;
  }
  return result;
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

function flushStreamingBuffer() {
  if (streamingBufferSamples < STREAM_CHUNK_SAMPLES) return;
  const combined = mergeFloat32(streamingBuffers, streamingBufferSamples);

  let offset = 0;
  while (combined.length - offset >= STREAM_CHUNK_SAMPLES) {
    const chunk = combined.subarray(offset, offset + STREAM_CHUNK_SAMPLES);
    sendStreamingChunk(chunk);
    offset += STREAM_CHUNK_SAMPLES;
  }

  const leftover = combined.subarray(offset);
  streamingBuffers = leftover.length ? [leftover] : [];
  streamingBufferSamples = leftover.length;
}

function appendStreamingSamples(input, inputSampleRate) {
  const resampled = resampleTo16k(input, inputSampleRate);
  if (!resampled || resampled.length === 0) return;

  streamingBuffers.push(resampled);
  streamingBufferSamples += resampled.length;
  flushStreamingBuffer();
}

function setupStreamingProcessor(sourceNode) {
  if (!globalContext) return;
  if (streamingProcessor) return;

  streamingProcessor = globalContext.createScriptProcessor(4096, 1, 1);
  streamingGain = globalContext.createGain();
  streamingGain.gain.value = 0.0001;

  streamingProcessor.onaudioprocess = (e) => {
    if (!streamingCaptureActive || !streamingActive) return;
    const input = e.inputBuffer.getChannelData(0);
    appendStreamingSamples(input, e.inputBuffer.sampleRate);
  };

  sourceNode.connect(streamingProcessor);
  streamingProcessor.connect(streamingGain);
  streamingGain.connect(globalContext.destination);
}

function teardownStreamingProcessor() {
  try {
    if (streamingProcessor) {
      streamingProcessor.disconnect();
      streamingProcessor.onaudioprocess = null;
    }
  } catch (_) { }
  try {
    if (streamingGain) streamingGain.disconnect();
  } catch (_) { }
  streamingProcessor = null;
  streamingGain = null;
  resetStreamingBuffers();
}

async function resolveEffectiveSettings() {
  const prevEnabled = extensionEnabledForSite;

  try {
    const hostname = normalizeHost(location.hostname);
    const { settings } = await browser.storage.local.get('settings');

    debugLogsEnabled = settings?.debugMode === true;
    shouldShowNotifications = settings?.toastNotificationsEnabled === true;
    debugLogToSiteConsole = debugLogsEnabled;

    disableProcessingTimeouts = settings?.disableProcessingTimeouts === true;

    const defaults = settings?.defaults || { silenceTimeoutMs: 1000 };
    const overrides = settings?.overrides || {};
    const site = overrides[hostname] || {};

    const timeoutRaw = site.silenceTimeoutMs ?? defaults.silenceTimeoutMs ?? 1000;
    const timeoutParsed = (typeof timeoutRaw === 'number') ? timeoutRaw : parseInt(timeoutRaw, 10);
    silenceTimeoutMs = Number.isFinite(timeoutParsed) ? timeoutParsed : 1000;

    disableHardCap = settings?.disableHardCap === true;

    hotkey = typeof settings?.hotkey === 'string' ? settings.hotkey : 'Alt+A';
    shortcutEnabled = settings?.shortcutEnabled !== false;
    sendEnterAfterResult = settings?.sendEnterAfterResult === true;

    normalizedHotkey = shortcutEnabled ? normalizeHotkey(hotkey) : null;

    stripTrailingPeriod = settings?.stripTrailingPeriod === true;
    disableSpaceNormalization = settings?.disableSpaceNormalization === true;

    const rawMicGain = (typeof site.micGain === 'number')
      ? site.micGain
      : (typeof defaults.micGain === 'number'
        ? defaults.micGain
        : (settings?.boostMicGain === true ? 1.8 : MIC_GAIN_DEFAULT));
    micGain = clampMicGain(rawMicGain);

    const rawSensitivity = (typeof site.silenceSensitivity === 'number')
      ? site.silenceSensitivity
      : (typeof defaults.silenceSensitivity === 'number'
        ? defaults.silenceSensitivity
        : SILENCE_SENSITIVITY_DEFAULT);
    silenceSensitivity = clampSilenceSensitivity(rawSensitivity);

    assemblyaiStreamingEnabled = settings?.assemblyaiStreamingEnabled !== false;
    streamingSilenceMode = normalizeStreamingSilenceMode(settings?.assemblyaiStreamingSilenceMode || 'never');

    const provider = getProviderFromSettings(settings, hostname);

    if (provider === 'assemblyai') {
      streamingProvider = assemblyaiStreamingEnabled ? 'assemblyai' : null;
    } else if (provider === 'vosk') {
      streamingProvider = 'vosk';
    } else {
      streamingProvider = null;
    }

    streamingActive = !!streamingProvider;

    extensionEnabledForSite = true;

    const disabledSites = settings?.disabledSites || {};
    for (const [k, v] of Object.entries(disabledSites)) {
      if (v === true && hostMatchesRule(hostname, normalizeHost(k))) {
        extensionEnabledForSite = false;
        break;
      }
    }
    if (extensionEnabledForSite && site && site.enabled === false) extensionEnabledForSite = false;

} catch (_) {
    silenceTimeoutMs = 1000;
    shouldShowNotifications = false;
    debugLogsEnabled = false;
    debugLogToSiteConsole = false;
    disableHardCap = false;
    hotkey = 'Alt+A';
    shortcutEnabled = true;
    sendEnterAfterResult = false;
    normalizedHotkey = normalizeHotkey(hotkey);
    extensionEnabledForSite = true;
    stripTrailingPeriod = false;
    micGain = MIC_GAIN_DEFAULT;
    silenceSensitivity = SILENCE_SENSITIVITY_DEFAULT;
    assemblyaiStreamingEnabled = false;
    streamingProvider = null;
    streamingActive = false;
    streamingSilenceMode = 'partial';
    disableSpaceNormalization = false;
    disableProcessingTimeouts = false;
  }

  pushPageConfig();

  // If the site just got disabled while running, stop immediately (no reload needed)
  if (prevEnabled && !extensionEnabledForSite) {
    clearProcessingWatchdog();
    clearLockedInsertionTarget();
    clearPendingPageAck();
    clearStartRecordingWatchdog();
    try {
      if (captureActive) stopRecording(true);
    } catch (_) { }
    if (processingSessionId != null) {
      try {
        browser.runtime.sendMessage({
          type: 'CANCEL_SESSION',
          sessionId: processingSessionId,
          hostname: location.hostname,
          pageInstanceId: PAGE_INSTANCE_ID
        });
      } catch (_) { }
      processingSessionId = null;
    }
  }
}
resolveEffectiveSettings();

// NEW: ensure all frames react to settings changes
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!changes.settings) return;
  resolveEffectiveSettings();
});

// per-page instance id so background can reset stale session state on reload/navigation.
const PAGE_INSTANCE_ID = (() => {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch (_) { }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
})();

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === 'CONFIG_CHANGED') resolveEffectiveSettings();

  if (message?.type === 'WHISPER_DEBUG_LOG') {
    dbgSite(message.tag, message.data);
  }

// Replace the existing WHISPER_CANCEL_ALL handler in the runtime.onMessage listener with this:
if (message?.type === 'WHISPER_CANCEL_ALL') {
  clearProcessingWatchdog();
  processingSessionId = null;
  captureActive = false;
  skipTranscribe = true;
  clearLockedInsertionTarget();
  clearPendingPageAck();
  clearStartRecordingWatchdog();
  try { stopRecording(true); } catch (_) { }

  // Show a more helpful toast depending on the cancel reason.
  // Background sends reason = 'assemblyai_api_missing' when the API key is absent.
  const reason = message?.reason || '';
  if (reason === 'assemblyai_api_missing') {
    showNotification("AssemblyAI API key missing. Set it in options.", "error");
  } else if (reason === 'assemblyai_token_error') {
    showNotification("AssemblyAI token error. Check your API key in options.", "error");
  } else if (reason === 'vosk_model_failed') {
    showNotification("Failed to load Vosk model. See options or try a different model.", "error");
  } else {
    showNotification("Canceled (settings changed)", "info");
  }
}

if (message?.type === 'WHISPER_STREAMING_STARTED') {
  // Show listening toast for streaming providers (Vosk)
  if (message.provider === 'vosk') {
    showNotification("Listening...", "recording");
  }
  return;
}

if (message?.type === 'WHISPER_TOAST') {
  // Generic background->page toast: { message, level }
  try {
    const m = String(message.message || '');
    const lvl = (message.level || 'info');
    showNotification(m, lvl);
  } catch (_) { }
  return;
}

});

function cancelProcessing(reason = 'user_restart') {
  if (processingSessionId == null) return false;

  try {
    browser.runtime.sendMessage({
      type: 'CANCEL_SESSION',
      sessionId: processingSessionId,
      hostname: location.hostname,
      pageInstanceId: PAGE_INSTANCE_ID
    });
  } catch (_) { }

  clearProcessingWatchdog();
  processingSessionId = null;
  clearLockedInsertionTarget();
  clearPendingPageAck();
  showNotification("Canceled", "info");
  dbg('processing_canceled', { reason });
  return true;
}

function handleHotkeyTrigger(e) {
  if (!extensionEnabledForSite) return;
  if (!shortcutEnabled || !normalizedHotkey) return;

  if (!captureActive && processingSessionId != null) {
    cancelProcessing('hotkey_restart');
  }

  if (isDocsHost()) {
    docsDispatchCtrlMetaShiftS();
  }

  if (e) {
    e.preventDefault();
    lockInsertionTargetFromEvent(e);
  } else {
    clearLockedInsertionTarget();
  }

  nextStartSource = 'hotkey';

  const langGuess = (navigator.language || 'en').split('-')[0] || 'en';
  if (captureActive) {
    window.postMessage({ type: 'WHISPER_STOP_RECORDING' }, "*");
  } else {
    window.postMessage({ type: 'WHISPER_START_RECORDING', language: langGuess, startSource: 'hotkey' }, "*");
  }
}

// hotkey start/stop (top frame)
document.addEventListener('keydown', (e) => {
  if (!IS_TOP_FRAME) return;
  if (!isHotkeyEvent(e)) return;
  handleHotkeyTrigger(e);
}, true);

// NEW: forward hotkey from Docs iframe -> top frame
if (!IS_TOP_FRAME && isDocsHost()) {
  document.addEventListener('keydown', (e) => {
    if (!isHotkeyEvent(e)) return;
    e.preventDefault();
    window.top.postMessage({ type: 'WHISPER_DOCS_HOTKEY' }, "*");
  }, true);
}

// NEW: receive forwarded hotkey in top frame
if (IS_TOP_FRAME) {
  window.addEventListener('message', (e) => {
    if (e?.data?.type !== 'WHISPER_DOCS_HOTKEY') return;
    if (!isDocsHost()) return;
    handleHotkeyTrigger();
  });
}

// Recommended Fix (Clean & Compliant):
if (extensionEnabledForSite) {
  const script = document.createElement('script');
  script.src = browser.runtime.getURL('polyfill.js'); // Use file for EVERYONE
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

function fixEncoding(text) {
  if (!text) return "";
  return text
    .replace(/â€”/g, "—")
    .replace(/â€“/g, "–")
    .replace(/â€™/g, "’")
    .replace(/â€œ/g, "“")
    .replace(/â€/g, "”")
    .replace(/â€¦/g, "…");
}

function applyOutputPostProcessing(text) {
  if (!text) return text;
  if (stripTrailingPeriod) {
    const trimmed = text.trimEnd();
    if (trimmed.endsWith('.')) {
      return trimmed.slice(0, -1);
    }
  }
  return text;
}

function showNotification(message, type = "info") {
  if (!shouldShowNotifications) return;
  const existing = document.getElementById("whisper-pill");
  if (existing) existing.remove();

  let bg = "rgba(15, 23, 42, 0.85)", icon = "✨";
  if (type === "processing") { bg = "rgba(245, 158, 11, 0.9)"; icon = "⚡"; }
  if (type === "success") { bg = "rgba(22, 163, 74, 0.9)"; icon = "✅"; }
  if (type === "error") { bg = "rgba(220, 38, 38, 0.9)"; icon = "⚠️"; }
  if (type === "recording") { bg = "rgba(37, 99, 235, 0.9)"; icon = "🎙️"; }

  const div = document.createElement("div");
  div.id = "whisper-pill";
  div.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  div.style.cssText = `
    position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%) translateY(20px);
    display: flex; align-items: center; gap: 10px; padding: 10px 20px;
    background: ${bg}; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    color: white; border-radius: 50px; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    font-size: 14px; font-weight: 500; box-shadow: 0 10px 25px rgba(0,0,0,0.15), 0 0 0 1px rgba(255,255,255,0.1);
    z-index: 2147483647; opacity: 0; transition: all .3s cubic-bezier(.16,1,.3,1); pointer-events: none;
  `;
  document.body.appendChild(div);
  requestAnimationFrame(() => { div.style.opacity = "1"; div.style.transform = "translateX(-50%) translateY(0)"; });

  const duration = type === "error" ? 4000 : 2500;
  setTimeout(() => {
    if (div) {
      div.style.opacity = "0";
      div.style.transform = "translateX(-50%) translateY(10px)";
      setTimeout(() => div.remove(), 300);
    }
  }, duration);
}

function resolveInsertTarget() {
  if (lockedInsertTarget && lockedInsertTarget.isConnected && isEditableTarget(lockedInsertTarget)) {
    return lockedInsertTarget;
  }
  return findActiveEditable();
}

function insertIntoElement(el, text) {
  if (!el || !isEditableTarget(el)) return false;

  if (isGoogleDocsOrSlidesHost()) {
    if (tryExecCommandInsert(text)) return true;

    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      el.value = el.value.substring(0, start) + text + el.value.substring(end);
      el.selectionStart = el.selectionEnd = start + text.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    dbg('Google host: insert skipped (no safe method)');
    return false;
  }

  try { el.focus?.(); } catch (_) { }

  if (tryExecCommandInsert(text)) return true;

  if (el.isContentEditable) {
    dbg('contentEditable insert failed (execCommand blocked)');
    return false;
  }

  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'input') {
    let start = el.selectionStart;
    let end = el.selectionEnd;

    if (lockedInsertTarget === el && lockedInsertTargetInfo) {
      if (typeof lockedInsertTargetInfo.selectionStart === 'number') start = lockedInsertTargetInfo.selectionStart;
      if (typeof lockedInsertTargetInfo.selectionEnd === 'number') end = lockedInsertTargetInfo.selectionEnd;
      try {
        if (typeof start === 'number' && typeof end === 'number') el.setSelectionRange?.(start, end);
      } catch (_) { }
    }

    start = el.selectionStart;
    end = el.selectionEnd;

    el.value = el.value.substring(0, start) + text + el.value.substring(end);
    el.selectionStart = el.selectionEnd = start + text.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  return false;
}

function trySubmitClosestFormForElement(el) {
  if (!el || el.nodeType !== 1) return false;

  const form = el.closest ? el.closest('form') : null;
  if (!form) return false;

  if (typeof form.requestSubmit === 'function') {
    try { form.requestSubmit(); return true; } catch (_) { }
  }

  try {
    const ev = new Event('submit', { bubbles: true, cancelable: true });
    const ok = form.dispatchEvent(ev);
    if (ok && typeof form.submit === 'function') {
      form.submit();
      return true;
    }
  } catch (_) { }

  try {
    if (typeof form.submit === 'function') { form.submit(); return true; }
  } catch (_) { }

  return false;
}

function fallbackSendEnterKeyForElement(el) {
  if (!el || !isEditableTarget(el)) return;

  try { el.focus?.(); } catch (_) { }

  for (const type of ['keydown', 'keypress', 'keyup']) {
    const ev = new KeyboardEvent(type, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    });
    el.dispatchEvent(ev);
  }
}

function sendEnterAfterInsertForTarget(el) {
  if (trySubmitClosestFormForElement(el)) return;
  fallbackSendEnterKeyForElement(el);
}

function pickBestRecorderMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm',
    'audio/ogg'
  ];
  for (const t of candidates) {
    try {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
    } catch (_) { }
  }
  return '';
}

// page bridge start/stop/abort
window.addEventListener("message", async (event) => {
  if (!IS_TOP_FRAME) return;
  if (!extensionEnabledForSite) return;
  if (!event.data) return;

  if (event.data.type === 'WHISPER_START_RECORDING') {
    if (processingSessionId !== null && !captureActive) {
      cancelProcessing('ui_restart');
    }
    if (captureActive) return;

    currentStartSource = event.data.startSource || nextStartSource || 'ui';
    nextStartSource = null;

    currentSessionId += 1;
    activeSessionId = currentSessionId;

    dbg('start_recording_requested', {
      sessionId: activeSessionId,
      host: location.hostname,
      lang: event.data.language,
      pageInstanceId: PAGE_INSTANCE_ID
    });

    startRecording(event.data.language, activeSessionId);
  }
// content.js - inside the window.addEventListener("message", ...) block
  else if (event.data.type === 'WHISPER_STOP_RECORDING') {
    // Duolingo safety check
    if (streamingActive && isDuolingoHost()) {
      dbg('ignore_duolingo_stop_streaming', { elapsed: Date.now() - recordingStartTime });
      return;
    }

    if (streamingActive) {
      setSpeechActive(false);
      setAudioActive(false);
      forceEndPageRecognition();

      // 1. Stop the microphone
      stopRecording(false); 

      // 2. ALWAYS tell the background to stop the stream
      if (streamingSessionId) {
        try {
          const type = (streamingProvider === 'assemblyai') ? 'ASSEMBLYAI_STREAM_STOP' : 'VOSK_STREAM_STOP';
          browser.runtime.sendMessage({
            type,
            sessionId: streamingSessionId,
            hostname: location.hostname,
            pageInstanceId: PAGE_INSTANCE_ID
          });
        } catch (_) { }
        
        // 3. Clean up local streaming state
        teardownStreamingProcessor();
        streamingSessionId = null;
        clearSilenceTimer();
        clearLockedInsertionTarget();
        clearPendingPageAck();
      }
      return;
    }
    
    // Non-streaming fallback (Local Whisper)
    if (captureActive) {
      stopRecording(false);
    }
  }

  else if (event.data.type === 'WHISPER_ABORT_RECORDING') {
    if (streamingActive && isDuolingoHost()) {
      dbg('ignore_duolingo_stop_streaming', { elapsed: Date.now() - recordingStartTime });
      return;
    }

    if (streamingActive) {
      setSpeechActive(false);
      setAudioActive(false);
      forceEndPageRecognition();

      if (captureActive) {
        stopRecording(false); // do NOT cancel
      } else if (streamingSessionId) {
        try {
          if (streamingProvider === 'assemblyai') {
            browser.runtime.sendMessage({
              type: 'ASSEMBLYAI_STREAM_STOP',
              sessionId: streamingSessionId,
              hostname: location.hostname,
              pageInstanceId: PAGE_INSTANCE_ID
            });
          } else if (streamingProvider === 'vosk') {
            browser.runtime.sendMessage({
              type: 'VOSK_STREAM_STOP',
              sessionId: streamingSessionId,
              hostname: location.hostname,
              pageInstanceId: PAGE_INSTANCE_ID
            });
          }
        } catch (_) { }

        teardownStreamingProcessor();
        streamingSessionId = null;
        clearSilenceTimer();
        clearLockedInsertionTarget();
        clearPendingPageAck();
      }
      return;
    }
    // non-streaming fallback (keep original)
    clearProcessingWatchdog();
    clearLockedInsertionTarget();
    clearPendingPageAck();
    clearStartRecordingWatchdog();
    if (captureActive) {
      stopRecording(true);
      try {
        browser.runtime.sendMessage({
          type: 'CANCEL_SESSION',
          sessionId: activeSessionId,
          hostname: location.hostname,
          pageInstanceId: PAGE_INSTANCE_ID
        });
      } catch (_) { }
    } else if (processingSessionId !== null) {
      try {
        browser.runtime.sendMessage({
          type: 'CANCEL_SESSION',
          sessionId: processingSessionId,
          hostname: location.hostname,
          pageInstanceId: PAGE_INSTANCE_ID
        });
      } catch (_) { }
      processingSessionId = null;
    }
  }
});

function clearSilenceTimer() {
  if (silenceCheckTimer) {
    clearTimeout(silenceCheckTimer);
    silenceCheckTimer = null;
  }
}

function stopStreamingOnly(reason = 'duolingo_foreignobject_removed') {
  dbg('stop_streaming_only_called', {
    reason,
    streamingActive,
    streamingSessionId,
    streamingCaptureActive
  });

  if (!streamingActive) return;

  // If a recording is active, stop it (this will also stop streaming)
  if (captureActive && globalRecorder && globalRecorder.state !== 'inactive') {
    stopRecording(false);
    return;
  }

  if (streamingSessionId) {
    try {
      if (streamingProvider === 'assemblyai') {
        browser.runtime.sendMessage({
          type: 'ASSEMBLYAI_STREAM_STOP',
          sessionId: streamingSessionId,
          hostname: location.hostname,
          pageInstanceId: PAGE_INSTANCE_ID
        });
      } else if (streamingProvider === 'vosk') {
        browser.runtime.sendMessage({
          type: 'VOSK_STREAM_STOP',
          sessionId: streamingSessionId,
          hostname: location.hostname,
          pageInstanceId: PAGE_INSTANCE_ID
        });
      }
    } catch (_) { }
  }

  teardownStreamingProcessor();
  streamingSessionId = null;
  streamingCaptureActive = false;
  clearSilenceTimer();
  clearLockedInsertionTarget();
  clearPendingPageAck();
}

function logRemovalParents(node, reason) {
  if (!debugLogsEnabled) return;
  const chain = [];
  let el = node?.parentNode;
  let depth = 0;
  while (el && depth < 8) {
    const tag = (el.tagName || '').toLowerCase();
    chain.push(tag || String(el.nodeName));
    el = el.parentNode;
    depth += 1;
  }
  dbg('foreignobject_removed_parent_chain', { reason, chain });
}

function installDuolingoForeignObjectRemovalStopper() {
  if (!IS_TOP_FRAME) return;
  if (!isDuolingoHost()) return;

  const hasForeignObject = (node) => {
    if (!node || node.nodeType !== 1) return false;
    if ((node.tagName || '').toLowerCase() === 'foreignobject') return true;
    return typeof node.querySelector === 'function' && node.querySelector('foreignObject');
  };

  const observer = new MutationObserver((mutations) => {
    if (!streamingActive) return;
    for (const m of mutations) {
      if (m.type !== 'childList') continue;
      for (const removed of m.removedNodes) {
        if (hasForeignObject(removed)) {
          logRemovalParents(removed, 'foreignobject_removed');
          stopStreamingOnly('duolingo_foreignobject_removed');
          return;
        }
      }
    }
  });

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true
  });
}

installDuolingoForeignObjectRemovalStopper();

async function startRecording(pageLanguage, sessionId) {
  // 🔎 force-read settings at the moment recording starts
try {
    // Wrap getUserMedia in a specific try/catch for permission errors
    try {
      globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (permError) {
      if (permError.name === 'NotAllowedError' || permError.name === 'PermissionDeniedError') {
        showNotification("Microphone access denied. Please allow it in browser settings.", "error");
      } else {
        showNotification("Could not access microphone: " + permError.message, "error");
      }
      // Clean up UI state since we can't record
      captureActive = false;
      await browser.runtime.sendMessage({
        type: 'RECORDING_STOP',
        sessionId,
        hostname: location.hostname,
        canceled: true,
        pageInstanceId: PAGE_INSTANCE_ID
      });
      return; 
    }

    dbg('gum_ok', { sessionId });
    const hostname = normalizeHost(location.hostname);
    const { settings } = await browser.storage.local.get('settings');

    const provider = getProviderFromSettings(settings, hostname);
    const assemblyEnabled = settings?.assemblyaiStreamingEnabled !== false;

    if (provider === 'vosk') {
      streamingProvider = 'vosk';
      streamingActive = true;
    } else if (provider === 'assemblyai' && assemblyEnabled) {
      streamingProvider = 'assemblyai';
      streamingActive = true;
    } else {
      streamingProvider = null;
      streamingActive = false;
    }

    console.log('[Whisper] provider check', {
      provider,
      streamingProvider,
      streamingActive,
      defaults: settings?.defaults
    });
  } catch (e) {
    console.warn('[Whisper] provider check failed', e);
  }

  clearStartRecordingWatchdog();

  if (sessionId !== activeSessionId) {
    dbg('start_recording_aborted_session_mismatch', { sessionId, activeSessionId });
    return;
  }


  try {
    // Determine a more accurate display language from background (uses Vosk model metadata / overrides)
    try {
      const resp = await browser.runtime.sendMessage({ type: 'GET_EFFECTIVE_LANGUAGE', hostname: location.hostname });
      if (resp && resp.ok && resp.language) {
        pageLanguage = resp.language;
      }
    } catch (_) { /* ignore */ }

    recordingStartTime = Date.now();
    streamingEverHeard = false; // NEW
    handledStreamingFinalSessionId = null; // NEW

    lastStreamingPartialText = null; // NEW
    lastStreamingPartialSessionId = null; // NEW
    clearPendingStreamingFinal(); // NEW

    globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    dbg('gum_ok', { sessionId });

    globalContext = new AudioContext();
    try { await globalContext.resume?.(); } catch (_) { }
    dbg('audiocontext_state', { sessionId, state: globalContext?.state });

    const source = globalContext.createMediaStreamSource(globalStream);

    const gainNode = globalContext.createGain();
    gainNode.gain.value = micGain;

    const analyser = globalContext.createAnalyser();
    analyser.fftSize = 256;

    source.connect(gainNode);
    gainNode.connect(analyser);

    const destination = globalContext.createMediaStreamDestination();
    gainNode.connect(destination);

    if (streamingActive) {
      streamingSessionId = sessionId;
      streamingCaptureActive = true;
      setupStreamingProcessor(source);
      try {
        if (streamingProvider === 'assemblyai') {
          browser.runtime.sendMessage({
            type: 'ASSEMBLYAI_STREAM_START',
            sessionId,
            hostname: location.hostname,
            language: pageLanguage,
            pageInstanceId: PAGE_INSTANCE_ID,
            sampleRate: STREAM_TARGET_SAMPLE_RATE
          });
        } else if (streamingProvider === 'vosk') {
          console.log('[Whisper] sending VOSK_STREAM_START', { sessionId, host: location.hostname });
          browser.runtime.sendMessage({
            type: 'VOSK_STREAM_START',
            sessionId,
            hostname: location.hostname,
            pageInstanceId: PAGE_INSTANCE_ID,
            sampleRate: STREAM_TARGET_SAMPLE_RATE
          });
        }
      } catch (_) { }
    }

    const mimeType = pickBestRecorderMimeType();
    globalRecorder = mimeType
      ? new MediaRecorder(destination.stream, { mimeType })
      : new MediaRecorder(destination.stream);

    globalChunks = [];
    skipTranscribe = false;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    let noiseFloor = 8;
    let lastHeard = Date.now();
    let everHeard = false;
    const startTime = Date.now();
    const maxNoSpeechMs = Math.max(2500, silenceTimeoutMs * 2.5);

    const applyStreamingSilence = streamingActive && shouldApplyStreamingSilenceTimeout();
    const applyStreamingIdle = streamingActive;

    let started = false;

    setAudioActive(true);
    setSpeechActive(false);

// Inside startRecording(...), in globalRecorder.onstart = () => { ... }
globalRecorder.onstart = () => {
  started = true;
  captureActive = true;
  clearStartRecordingWatchdog();
  // Show listening toast so users get immediate feedback
  showNotification("Listening...", "recording");
  dbg('mediarecorder_onstart', { sessionId, state: globalRecorder?.state, mimeType: globalRecorder?.mimeType });

  try {
    browser.runtime.sendMessage({
      type: 'RECORDING_START',
      sessionId,
      hostname: location.hostname,
      pageInstanceId: PAGE_INSTANCE_ID
    });
  } catch (_) { }
};

    globalRecorder.onerror = (e) => {
      dbg('mediarecorder_error', { sessionId, error: e?.error?.name || e?.message || String(e) });
      if (!started) {
        showNotification("Failed to start recording. Click again.", "error");
      }
    };

    startRecordingWatchdog = setTimeout(() => {
      startRecordingWatchdog = null;

      const state = globalRecorder?.state || 'unknown';
      dbg('start_watchdog_fired', { sessionId, state, started });

      if (state !== 'recording') {
        try { stopRecording(true); } catch (_) { }
        captureActive = false;

        try {
          browser.runtime.sendMessage({
            type: 'RECORDING_STOP',
            sessionId,
            hostname: location.hostname,
            canceled: true,
            pageInstanceId: PAGE_INSTANCE_ID
          });
        } catch (_) { }

        showNotification("Mic didn’t start recording—please click again.", "error");
      }
    }, START_RECORDING_WATCHDOG_MS);

    const checkSilence = () => {
      if (!captureActive || !globalRecorder || globalRecorder.state === 'inactive') return;

      analyser.getByteFrequencyData(dataArray);
      let sum = 0; for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;

      noiseFloor = Math.min(35, noiseFloor * 0.97 + avg * 0.03);
      const speechThreshold = noiseFloor + silenceSensitivity;
      const silenceThreshold = noiseFloor + Math.max(2, Math.round(silenceSensitivity / 3));

      const now = Date.now();
      const speaking = avg > speechThreshold;

      setSpeechActive(speaking);

      if (speaking) {
        lastHeard = now;
        everHeard = true;
        if (streamingActive) streamingEverHeard = true; // NEW
      }

      const sinceHeard = now - lastHeard;

      if (streamingActive) {
        if (applyStreamingSilence) {
          // NEW: Duolingo plays a prompt first; skip the no‑speech timeout there
          if (!isDuolingoHost()) {
            if (!everHeard && (now - startTime > maxNoSpeechMs)) {
              dbg('STREAM_STOP no-speech', { elapsed: now - startTime, maxNoSpeechMs, host: location.hostname });
              stopRecording(false);
              forceEndPageRecognition();
              return;
            }
          }

          if (everHeard && avg < silenceThreshold && sinceHeard > silenceTimeoutMs) {
            stopRecording(false);
            forceEndPageRecognition();
            return;
          }
        }

        if (applyStreamingIdle && sinceHeard > STREAM_IDLE_TIMEOUT_MS) {
          stopRecording(false);
          forceEndPageRecognition();
          return;
        }

        silenceCheckTimer = setTimeout(checkSilence, 120);
        return;
      }

      if (!everHeard && (now - startTime > maxNoSpeechMs)) { stopRecording(false); return; }
      if (everHeard && avg < silenceThreshold && sinceHeard > silenceTimeoutMs) { stopRecording(false); return; }

      silenceCheckTimer = setTimeout(checkSilence, 120);
    };

    globalRecorder.ondataavailable = event => globalChunks.push(event.data);

    globalRecorder.onstop = async () => {
      clearSilenceTimer();
      clearStartRecordingWatchdog();
      setSpeechActive(false);
      setAudioActive(false);

      try {
        const duration = Date.now() - recordingStartTime;

        try {
          if (started) {
            browser.runtime.sendMessage({
              type: 'RECORDING_STOP',
              sessionId,
              hostname: location.hostname,
              canceled: skipTranscribe,
              pageInstanceId: PAGE_INSTANCE_ID
            });
          }
        } catch (_) { }

        dbg('mediarecorder_onstop', {
          sessionId,
          started,
          durationMs: duration,
          canceled: skipTranscribe,
          chunks: globalChunks?.length || 0
        });

        if (streamingActive) {
          try {
            if (streamingProvider === 'assemblyai') {
              browser.runtime.sendMessage({
                type: 'ASSEMBLYAI_STREAM_STOP',
                sessionId,
                hostname: location.hostname,
                pageInstanceId: PAGE_INSTANCE_ID
              });
            } else if (streamingProvider === 'vosk') {
              browser.runtime.sendMessage({
                type: 'VOSK_STREAM_STOP',
                sessionId,
                hostname: location.hostname,
                pageInstanceId: PAGE_INSTANCE_ID
              });
            }
          } catch (_) { }
          teardownStreamingProcessor();
          streamingSessionId = null;
          streamingCaptureActive = false;
          clearLockedInsertionTarget();
          clearPendingPageAck();
          return;
        }

        if (!started) {
          captureActive = false;
          clearLockedInsertionTarget();
          clearPendingPageAck();
          return;
        }

        if (skipTranscribe) { captureActive = false; clearLockedInsertionTarget(); clearPendingPageAck(); return; }
        if (duration < 300) { captureActive = false; clearLockedInsertionTarget(); clearPendingPageAck(); return; }
        if (sessionId !== activeSessionId) { captureActive = false; clearLockedInsertionTarget(); clearPendingPageAck(); return; }
        if (!extensionEnabledForSite) { captureActive = false; clearLockedInsertionTarget(); clearPendingPageAck(); return; }

        showNotification("Processing...", "processing");

        const realType = globalRecorder?.mimeType || 'application/octet-stream';
        const audioBlob = new Blob(globalChunks, { type: realType });
        const arrayBuffer = await audioBlob.arrayBuffer();

        processingSessionId = sessionId;
        armProcessingWatchdog(sessionId);

        try {
          dbg('sending_audio_to_background', { sessionId, bytes: arrayBuffer?.byteLength || 0, realType });

          browser.runtime.sendMessage({
            type: 'TRANSCRIBE_AUDIO',
            sessionId,
            audioData: arrayBuffer,
            language: pageLanguage,
            hostname: location.hostname,
            pageInstanceId: PAGE_INSTANCE_ID
          });
        } catch (e) {
          clearProcessingWatchdog();
          processingSessionId = null;
          showNotification("Failed to send audio to background: " + (e?.message || e), "error");
          clearLockedInsertionTarget();
          clearPendingPageAck();
        }
      } finally {
        captureActive = false;
      }
    };

    globalRecorder.start();
    dbg('mediarecorder_start_called', { sessionId, state: globalRecorder?.state, mimeType: globalRecorder?.mimeType });

    silenceCheckTimer = setTimeout(checkSilence, 120);

    if (!streamingActive) {
      if (!disableHardCap) {
        setTimeout(() => {
          if (captureActive && sessionId === activeSessionId) stopRecording(false);
        }, 5000);
      }
    }
  } catch (err) {
    clearSilenceTimer();
    clearStartRecordingWatchdog();
    captureActive = false;
    clearLockedInsertionTarget();
    clearPendingPageAck();
    teardownStreamingProcessor();
    streamingSessionId = null;
    streamingCaptureActive = false;

    dbg('startRecording_error', { sessionId, error: err?.message || String(err) });

    try {
      browser.runtime.sendMessage({
        type: 'RECORDING_STOP',
        sessionId,
        hostname: location.hostname,
        canceled: true,
        pageInstanceId: PAGE_INSTANCE_ID
      });
    } catch (_) { }

    showNotification("Error: " + (err?.message || err), "error");
    try { stopRecording(true); } catch (_) { }
  }
}

function stopRecording(cancel = false) {
  // 1. Kill the gatekeeper immediately
  streamingCaptureActive = false;
  
  clearSilenceTimer();
  clearStartRecordingWatchdog();
  skipTranscribe = cancel;

  clearPendingStreamingFinal();
  lastStreamingPartialText = null;
  lastStreamingPartialSessionId = null;

  // 2. Stop hardware
  if (globalStream) { 
    globalStream.getTracks().forEach(track => track.stop()); 
    globalStream = null; 
  }
  if (globalContext && globalContext.state !== 'closed') { 
    globalContext.close(); 
    globalContext = null; 
  }
  if (globalRecorder && globalRecorder.state !== 'inactive') { 
    globalRecorder.stop(); 
  }

  captureActive = false;
}

// Responses
let lastTextTime = 0;
let lastText = "";

browser.runtime.onMessage.addListener((message) => {
  if (!IS_TOP_FRAME) return;

  if (message.type === 'WHISPER_RESULT_TO_PAGE_BRIDGE') {
    const sid = message.sessionId || activeSessionId || 0;

    // --- FIX 1: Ghost Text Protection ---
    // Only block if this specific Session ID has been marked as "Fully Done"
    if (handledStreamingFinalSessionId === sid) {
      return;
    }

    // --- FIX 2: Hard Stop (Gatekeeper) ---
    // We only drop packets if 'streamingCaptureActive' is false (meaning you clicked STOP).
    // If you are still talking (captureActive is true), we let it through!
    const isStreaming = streamingActive === true;
    if (isStreaming && !streamingCaptureActive) {
      dbg('dropped_late_streaming_packet', { sid, text: message.text });
      return;
    }

    clearProcessingWatchdog();
    processingSessionId = null;

    let text = fixEncoding(message.text);
    text = applyOutputPostProcessing(text);
    const isFinal = message.isFinal !== false;

    const sendFinal = (finalText) => {
      // Duolingo special handling: only stop if it's AssemblyAI (Standard behavior for that site)
      if (isFinal && isStreaming && streamingProvider === 'assemblyai' && isDuolingoHost()) {
        handledStreamingFinalSessionId = sid;
        try { stopRecording(false); } catch (_) { }
      }

      // --- THE CHANGE ---
      // We NO LONGER set handledStreamingFinalSessionId = sid here for everyone.
      // This allows the stream to stay open for the next sentence.

      const now = Date.now();
      if (finalText === lastText && (now - lastTextTime < 2000)) return;
      lastText = finalText; lastTextTime = now;

      showNotification(finalText, "success");

      const target = resolveInsertTarget();
      const ackPromise = waitForPageHandledAck(sid);

      window.postMessage({ type: 'WHISPER_RESULT_TO_PAGE', text: finalText, isFinal: true, streaming: isStreaming }, "*");

      ackPromise.then((pageHandled) => {
        if (pageHandled) return;

        const normalizedText = normalizeInsertText(target, finalText);
        insertIntoElement(target, normalizedText);

        if (sendEnterAfterResult && !isGoogleDocsOrSlidesHost()) {
          sendEnterAfterInsertForTarget(target || document.activeElement);
        }
      }).finally(() => {
        // Only clear target if the mic is actually turned off
        if (!streamingCaptureActive) {
          clearLockedInsertionTarget();
        }
      });
    };

    // Vosk/Assembly logic continues below as before...
    if (isFinal && isStreaming && streamingProvider === 'vosk') {
      clearPendingStreamingFinal();
      sendFinal(text);
      return;
    }

    if (!isFinal) {
      window.postMessage({ type: 'WHISPER_RESULT_TO_PAGE', text, isFinal: false, streaming: isStreaming }, "*");
      return;
    }

    if (isStreaming) {
      const normalizedFinal = normalizeStreamingText(text);
      const normalizedPartial = normalizeStreamingText(lastStreamingPartialSessionId === sid ? lastStreamingPartialText : '');

      if (normalizedPartial && normalizedPartial === normalizedFinal) {
        clearPendingStreamingFinal();
        sendFinal(text);
        return;
      }

      clearPendingStreamingFinal();
      pendingStreamingFinal = {
        sessionId: sid,
        text,
        timer: setTimeout(() => {
          const pendingText = pendingStreamingFinal?.text;
          pendingStreamingFinal = null;
          sendFinal(pendingText);
        }, STREAMING_FINAL_STABILITY_MS)
      };
      return;
    }

    sendFinal(text);
  }

  else if (message.type === 'WHISPER_NO_AUDIO') {
    clearProcessingWatchdog();
    processingSessionId = null;
    clearLockedInsertionTarget();
    clearPendingPageAck();
    clearStartRecordingWatchdog();

    if (message.reason !== 'silence') showNotification("No speech detected", "info");
    else { const n = document.getElementById("whisper-pill"); if (n) n.style.opacity = "0"; }
  }
  else if (message.type === 'WHISPER_UNINTELLIGIBLE') {
    clearProcessingWatchdog();
    processingSessionId = null;
    clearLockedInsertionTarget();
    clearPendingPageAck();
    clearStartRecordingWatchdog();
    showNotification("Didn't catch that", "error");
  }
  else if (message.type === 'WHISPER_ERROR') {
    clearProcessingWatchdog();
    processingSessionId = null;
    clearLockedInsertionTarget();
    clearPendingPageAck();
    clearStartRecordingWatchdog();
    showNotification(message.error || "Transcription error", "error");
  }
  else if (message.type === 'WHISPER_DISABLED') {
    clearProcessingWatchdog();
    processingSessionId = null;
    clearLockedInsertionTarget();
    clearPendingPageAck();
    clearStartRecordingWatchdog();
    showNotification("Whisper is disabled on this site.", "info");
  }
});