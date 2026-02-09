// content.js - Firefox MV2
// Fix for "fake enter" not recognized:
// - Prefer submitting the closest form via requestSubmit() (works on GitHub search, many React apps)
// - Fall back to form.submit() or synthetic Enter only if needed.
// - Debug mode: can mirror background debug logs into the *site's* console.

// Behavior:
// - Hotkey works even if we can't resolve an editable at keydown time (needed for shadow/contenteditable editors).
// - BUT: we capture the "intended" editable target (when possible) at hotkey time,
//   and insert the transcription back into that same element for full functionality.

// NOTE (duplicate-text fix):
// Some sites (e.g. speechnotes.co) already insert text when they receive a WebSpeech result.
// Previously we BOTH inserted directly AND forwarded the result to the SpeechRecognition bridge,
// causing duplicated text.
// Now we do: forward to page FIRST, then wait briefly for a WHISPER_PAGE_HANDLED ack.
// - If ack arrives => assume page handled insertion => do NOT insert.
// - If no ack => fall back to direct insertion.
// Caveat: a site could ack but not actually insert text. This is rare for sites that ack,
// but if it happens, increase PAGE_ACK_TIMEOUT_MS or add a "did editor change?" check.

const IS_TOP_FRAME = (window.self === window.top);
if (!IS_TOP_FRAME) {
  // Do not throw in iframes (Google Docs/Slides rely on them).
  // Just don't initialize Whisper in iframes.
}

const MIC_GAIN_MULTIPLIER = 1.8;

let silenceTimeoutMs = 1000;
let shouldShowNotifications = false;
let captureActive = false;
let currentSessionId = 0;
let activeSessionId = 0;
let recordingStartTime = 0;

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
let boostMicGain = false;

// watchdog
let processingWatchdog = null;
const PROCESSING_WATCHDOG_MS = 22000;

// NEW: lock insertion target per session
let lockedInsertTarget = null;
let lockedInsertTargetInfo = null;

// NEW: page-bridge ack tracking (duplicate-text fix)
let pendingPageAck = null; // { sessionId, timer, resolve }
const PAGE_ACK_TIMEOUT_MS = 220;

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

function tryExecCommandInsert(text) {
  try {
    // returns false if the command is unsupported/blocked
    return document.execCommand && document.execCommand('insertText', false, text);
  } catch (_) {
    return false;
  }
}

function dbg(...args) {
  if (shouldShowNotifications) console.log('[Whisper DEBUG]', ...args);
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

// Grab "best guess" editable from event path / active element.
// This is used ONLY to lock insertion target on hotkey press.
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

  // capture caret for inputs/textareas
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
  // Prefer a real editable if we can find one, otherwise keep null and we’ll fallback later.
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

function normalizeHost(host) { return (host || '').trim().toLowerCase(); }
function hostMatchesRule(host, ruleHost) {
  if (!host || !ruleHost) return false;
  if (host === ruleHost) return true;
  return host.endsWith('.' + ruleHost);
}

async function resolveEffectiveSettings() {
  const prevEnabled = extensionEnabledForSite;

  try {
    const hostname = normalizeHost(location.hostname);
    const { settings } = await browser.storage.local.get('settings');
    shouldShowNotifications = settings?.debugMode === true;
    debugLogToSiteConsole = settings?.debugMode === true;

    const defaults = settings?.defaults || { silenceTimeoutMs: 1000 };
    const overrides = settings?.overrides || {};
    const site = overrides[hostname] || {};

    silenceTimeoutMs = site.silenceTimeoutMs ?? defaults.silenceTimeoutMs ?? 1000;
    disableHardCap = settings?.disableHardCap === true;

    hotkey = typeof settings?.hotkey === 'string' ? settings.hotkey : 'Alt+A';
    shortcutEnabled = settings?.shortcutEnabled !== false;
    sendEnterAfterResult = settings?.sendEnterAfterResult === true;

    normalizedHotkey = shortcutEnabled ? normalizeHotkey(hotkey) : null;

    stripTrailingPeriod = settings?.stripTrailingPeriod === true;
    boostMicGain = settings?.boostMicGain === true;

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
    debugLogToSiteConsole = false;
    disableHardCap = false;
    hotkey = 'Alt+A';
    shortcutEnabled = true;
    sendEnterAfterResult = false;
    normalizedHotkey = normalizeHotkey(hotkey);
    extensionEnabledForSite = true;
    stripTrailingPeriod = false;
    boostMicGain = false;
  }

  // If the site just got disabled while running, stop immediately (no reload needed)
  if (prevEnabled && !extensionEnabledForSite) {
    clearProcessingWatchdog();
    clearLockedInsertionTarget();
    clearPendingPageAck();
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

  if (message?.type === 'WHISPER_CANCEL_ALL') {
    clearProcessingWatchdog();
    processingSessionId = null;
    captureActive = false;
    skipTranscribe = true;
    clearLockedInsertionTarget();
    clearPendingPageAck();
    try { stopRecording(true); } catch (_) { }
    showNotification("Canceled (settings changed)", "info");
  }
});

// hotkey start/stop
document.addEventListener('keydown', (e) => {
  if (!IS_TOP_FRAME) return;
  if (!extensionEnabledForSite) return;
  if (!shortcutEnabled || !normalizedHotkey) return;
  if (!isHotkeyEvent(e)) return;

  e.preventDefault();

  // Lock target at the moment user hits the hotkey (best-effort).
  // This restores "full functionality": insert back into the intended textarea/contenteditable.
  lockInsertionTargetFromEvent(e);

  const langGuess = (navigator.language || 'en').split('-')[0] || 'en';
  if (captureActive) {
    window.postMessage({ type: 'WHISPER_STOP_RECORDING' }, "*");
  } else {
    if (processingSessionId !== null) return;
    window.postMessage({ type: 'WHISPER_START_RECORDING', language: langGuess }, "*");
  }
}, true);

// polyfill injection (only when enabled + top frame)
if (IS_TOP_FRAME) {
  const INLINE_CODE = `
  (function() {
    if (window.webkitSpeechRecognition) return;
    window.webkitSpeechRecognitionEvent = class SpeechRecognitionEvent extends Event {
      constructor(type, options) {
          super(type, options);
          this.results = options ? options.results : [];
          this.resultIndex = options ? options.resultIndex : 0;
      }
    };
    window.webkitSpeechRecognition = class SpeechRecognition {
      constructor() {
        this.continuous = false; this.interimResults = false; this.lang = 'en-US';
        this.onresult = null; this.onend = null; this.onstart = null; this.isRecording = false;
        window.addEventListener("message", (e) => {
          if (e.data && e.data.type === 'WHISPER_RESULT_TO_PAGE') {
               if (!this.onresult) return;
               const evt = new window.webkitSpeechRecognitionEvent('result', {
                  results: [[ { transcript: e.data.text, confidence: 0.98, isFinal: true } ]],
                  resultIndex: 0
               });
               evt.results[0].isFinal = true;
               this.onresult?.(evt);
               this.onend?.();
               this.isRecording = false;
               window.postMessage({ type: 'WHISPER_PAGE_HANDLED' }, "*");
          }
        });
      }
      start() {
        if (this.isRecording) return;
        this.isRecording = true; this.onstart?.();
        let reqLang = (this.lang || 'en').split('-')[0];
        window.postMessage({ type: 'WHISPER_START_RECORDING', language: reqLang }, "*");
      }
      stop() {
        this.isRecording = false;
        window.postMessage({ type: 'WHISPER_STOP_RECORDING' }, "*");
        this.onend?.();
      }
      abort() {
        this.isRecording = false;
        window.postMessage({ type: 'WHISPER_ABORT_RECORDING' }, "*");
        this.onend?.();
      }
    };
  })();
  `;

  if (extensionEnabledForSite) {
    const isGoogle = window.location.hostname.includes("google");
    if (isGoogle) {
      const script = document.createElement('script');
      script.src = browser.runtime.getURL('polyfill.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } else {
      const script = document.createElement('script');
      script.textContent = INLINE_CODE;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    }
  }
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
  // If we still have a locked target and it’s still in the DOM, use it.
  if (lockedInsertTarget && lockedInsertTarget.isConnected && isEditableTarget(lockedInsertTarget)) {
    return lockedInsertTarget;
  }

  // Otherwise fallback to current active.
  return findActiveEditable();
}

function insertIntoElement(el, text) {
  if (!el || !isEditableTarget(el)) return false;

  // Google Docs/Slides special handling stays
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

  // Non-Google: prefer execCommand first (best for rich editors)
  // Try focusing the element first, to improve insert reliability.
  try { el.focus?.(); } catch (_) { }

  if (tryExecCommandInsert(text)) return true;

  if (el.isContentEditable) {
    dbg('contentEditable insert failed (execCommand blocked)');
    return false;
  }

  // input/textarea path
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'input') {
    // Prefer restoring caret if we captured it
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
    if (processingSessionId !== null) return;
    if (captureActive) return;

    captureActive = true;
    currentSessionId += 1;
    activeSessionId = currentSessionId;

    try {
      browser.runtime.sendMessage({
        type: 'RECORDING_START',
        sessionId: activeSessionId,
        hostname: location.hostname,
        pageInstanceId: PAGE_INSTANCE_ID
      });
    } catch (_) { }

    startRecording(event.data.language, activeSessionId);
  }
  else if (event.data.type === 'WHISPER_STOP_RECORDING') {
    if (captureActive) stopRecording(false);
  }
  else if (event.data.type === 'WHISPER_ABORT_RECORDING') {
    clearProcessingWatchdog();
    clearLockedInsertionTarget();
    clearPendingPageAck();
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

async function startRecording(pageLanguage, sessionId) {
  try {
    const langDisplay = pageLanguage ? pageLanguage.toUpperCase() : "AUTO";
    showNotification(`Listening (${langDisplay})...`, "recording");

    recordingStartTime = Date.now();
    globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    globalContext = new AudioContext();
    const source = globalContext.createMediaStreamSource(globalStream);

    const gainNode = globalContext.createGain();
    gainNode.gain.value = boostMicGain ? MIC_GAIN_MULTIPLIER : 1;

    const analyser = globalContext.createAnalyser();
    analyser.fftSize = 256;

    source.connect(gainNode);
    gainNode.connect(analyser);

    const destination = globalContext.createMediaStreamDestination();
    gainNode.connect(destination);

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

    const checkSilence = () => {
      if (!captureActive || globalRecorder.state === 'inactive') return;

      analyser.getByteFrequencyData(dataArray);
      let sum = 0; for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;

      noiseFloor = Math.min(35, noiseFloor * 0.97 + avg * 0.03);
      const speechThreshold = noiseFloor + 12;
      const silenceThreshold = noiseFloor + 4;

      const now = Date.now();
      if (avg > speechThreshold) {
        lastHeard = now;
        everHeard = true;
      }

      const sinceHeard = now - lastHeard;

      if (!everHeard && (now - startTime > maxNoSpeechMs)) { stopRecording(false); return; }
      if (everHeard && avg < silenceThreshold && sinceHeard > silenceTimeoutMs) { stopRecording(false); return; }

      silenceCheckTimer = setTimeout(checkSilence, 120);
    };
    silenceCheckTimer = setTimeout(checkSilence, 120);

    globalRecorder.ondataavailable = event => globalChunks.push(event.data);

    globalRecorder.onstop = async () => {
      clearSilenceTimer();
      try {
        const duration = Date.now() - recordingStartTime;

        try {
          browser.runtime.sendMessage({
            type: 'RECORDING_STOP',
            sessionId,
            hostname: location.hostname,
            canceled: skipTranscribe,
            pageInstanceId: PAGE_INSTANCE_ID
          });
        } catch (_) { }

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

    if (!disableHardCap) {
      setTimeout(() => {
        if (captureActive && sessionId === activeSessionId) stopRecording(false);
      }, 5000);
    }
  } catch (err) {
    clearSilenceTimer();
    captureActive = false;
    clearLockedInsertionTarget();
    clearPendingPageAck();
    try {
      browser.runtime.sendMessage({
        type: 'RECORDING_STOP',
        sessionId,
        hostname: location.hostname,
        canceled: true,
        pageInstanceId: PAGE_INSTANCE_ID
      });
    } catch (_) { }
    showNotification("Error: " + err.message, "error");
  }
}

function stopRecording(cancel = false) {
  clearSilenceTimer();
  skipTranscribe = cancel;

  if (globalStream) { globalStream.getTracks().forEach(track => track.stop()); globalStream = null; }
  if (globalContext && globalContext.state !== 'closed') { globalContext.close(); globalContext = null; }
  if (globalRecorder && globalRecorder.state !== 'inactive') { globalRecorder.stop(); }

  captureActive = false;
}

// Responses
let lastTextTime = 0;
let lastText = "";

browser.runtime.onMessage.addListener((message) => {
  if (!IS_TOP_FRAME) return;

  if (message.type === 'WHISPER_RESULT_TO_PAGE_BRIDGE') {
    clearProcessingWatchdog();
    processingSessionId = null;

    let text = fixEncoding(message.text);
    text = applyOutputPostProcessing(text);
    const now = Date.now();
    if (text === lastText && (now - lastTextTime < 2000)) return;
    lastText = text; lastTextTime = now;

    showNotification(text, "success");

    // Always resolve target now (we'll use it only if we need fallback insertion)
    const target = resolveInsertTarget();

    // NEW: bridge-first, insertion fallback (prevents duplicate insertion on sites that handle WebSpeech)
    const sid = message.sessionId || activeSessionId || 0;
    const ackPromise = waitForPageHandledAck(sid);

    // Forward to page SpeechRecognition bridge first
    window.postMessage({ type: 'WHISPER_RESULT_TO_PAGE', text }, "*");

    ackPromise.then((pageHandled) => {
      if (pageHandled) {
        // Page handled the result (likely inserted). Do NOT insert.
        return;
      }

      // Fallback: insert ourselves
      const inserted = insertIntoElement(target, text);
      if (!inserted) {
        dbg('Insert failed; no editable target', { lockedInsertTargetInfo });
      }

      if (sendEnterAfterResult && !isGoogleDocsOrSlidesHost()) {
        // Submit/enter should apply to the same target we inserted into (or attempted to).
        sendEnterAfterInsertForTarget(target || document.activeElement);
      }
    }).finally(() => {
      // Clear lock after completion so next run can capture a new target
      clearLockedInsertionTarget();
      // ack state already cleared by waiter; but safe:
      // clearPendingPageAck();
    });
  }
  else if (message.type === 'WHISPER_NO_AUDIO') {
    clearProcessingWatchdog();
    processingSessionId = null;
    clearLockedInsertionTarget();
    clearPendingPageAck();

    if (message.reason !== 'silence') showNotification("No speech detected", "info");
    else { const n = document.getElementById("whisper-pill"); if (n) n.style.opacity = "0"; }
  }
  else if (message.type === 'WHISPER_UNINTELLIGIBLE') {
    clearProcessingWatchdog();
    processingSessionId = null;
    clearLockedInsertionTarget();
    clearPendingPageAck();
    showNotification("Didn't catch that", "error");
  }
  else if (message.type === 'WHISPER_ERROR') {
    clearProcessingWatchdog();
    processingSessionId = null;
    clearLockedInsertionTarget();
    clearPendingPageAck();
    showNotification(message.error || "Transcription error", "error");
  }
  else if (message.type === 'WHISPER_DISABLED') {
    clearProcessingWatchdog();
    processingSessionId = null;
    clearLockedInsertionTarget();
    clearPendingPageAck();
    showNotification("Whisper is disabled on this site.", "info");
  }
});