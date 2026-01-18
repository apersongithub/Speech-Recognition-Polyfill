// content.js - Firefox MV2
// Fix for "fake enter" not recognized:
// - Prefer submitting the closest form via requestSubmit() (works on GitHub search, many React apps)
// - Fall back to form.submit() or synthetic Enter only if needed.
// - Debug mode: can mirror background debug logs into the *site's* console.

if (window.self !== window.top) {
  throw new Error("Whisper: Skipping iframe execution.");
}

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

// NEW: debug log forwarding (background -> content -> site console)
let debugLogToSiteConsole = false;

// watchdog
let processingWatchdog = null;
const PROCESSING_WATCHDOG_MS = 22000;

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

function isEditableTarget(t) {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName || '').toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    const type = (t.type || '').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden'].includes(type);
  }
  return false;
}

async function resolveEffectiveSettings() {
  try {
    const hostname = location.hostname;
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
  } catch (_) {
    silenceTimeoutMs = 1000;
    shouldShowNotifications = false;
    debugLogToSiteConsole = false;
    disableHardCap = false;
    hotkey = 'Alt+A';
    shortcutEnabled = true;
    sendEnterAfterResult = false;
    normalizedHotkey = normalizeHotkey(hotkey);
  }
}
resolveEffectiveSettings();

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === 'CONFIG_CHANGED') resolveEffectiveSettings();

  // NEW: receive background debug logs and print to the site's console
  if (message?.type === 'WHISPER_DEBUG_LOG') {
    dbgSite(message.tag, message.data);
  }
});

// hotkey start/stop
document.addEventListener('keydown', (e) => {
  if (!shortcutEnabled || !normalizedHotkey) return;
  if (!isEditableTarget(e.target)) return;
  if (!isHotkeyEvent(e)) return;
  e.preventDefault();

  const langGuess = (navigator.language || 'en').split('-')[0] || 'en';

  if (captureActive) {
    window.postMessage({ type: 'WHISPER_STOP_RECORDING' }, "*");
  } else {
    if (processingSessionId !== null) return;
    window.postMessage({ type: 'WHISPER_START_RECORDING', language: langGuess }, "*");
  }
}, true);

// polyfill injection (unchanged)
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

function simulateTyping(element, text) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    let key = char;
    let code = `Key${char.toUpperCase()}`;
    let keyCode = char.charCodeAt(0);
    let charCode = keyCode;

    if (char === ' ') {
      key = ' ';
      code = 'Space';
      keyCode = 32;
      charCode = 32;
    } else if (!/[a-zA-Z0-9]/.test(char)) {
      // For punctuation, use the char as key, and appropriate code
      code = char;
    }

    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      key,
      code,
      keyCode,
      charCode,
      which: keyCode,
    };

    const keydown = new KeyboardEvent('keydown', eventInit);
    if (!element.dispatchEvent(keydown)) continue;

    const keypress = new KeyboardEvent('keypress', eventInit);
    if (!element.dispatchEvent(keypress)) continue;

    // Dispatch input event to mimic text insertion
    const inputEvent = new InputEvent('input', {
      bubbles: true,
      composed: true,
      data: char,
      inputType: 'insertText',
    });
    element.dispatchEvent(inputEvent);

    const keyup = new KeyboardEvent('keyup', eventInit);
    element.dispatchEvent(keyup);
  }
}

function insertIntoActiveEditable(text) {
  const active = document.activeElement;
  if (!isEditableTarget(active)) {
    dbg('No editable target');
    return;
  }

  if (active.isContentEditable) {
    if (location.hostname === 'docs.google.com' || location.hostname === 'sheets.google.com') {
      // Use direct DOM manipulation for Google Docs and Sheets to insert text at cursor
      insertTextAtCursor(active, text);
    } else {
      // Original method for other sites
      document.execCommand('insertText', false, text);
    }
  } else {
    // Original for input/textarea (unchanged)
    const start = active.selectionStart;
    const end = active.selectionEnd;
    active.value = active.value.substring(0, start) + text + active.value.substring(end);
    active.selectionStart = active.selectionEnd = start + text.length;
    active.dispatchEvent(new Event('input', { bubbles: true }));
    active.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function insertTextAtCursor(element, text) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return;

  const range = selection.getRangeAt(0);
  range.deleteContents(); // Remove any selected content

  const textNode = document.createTextNode(text);
  range.insertNode(textNode);

  // Move cursor to after the inserted text
  range.setStartAfter(textNode);
  range.setEndAfter(textNode);
  selection.removeAllRanges();
  selection.addRange(range);

  // Dispatch input event to notify the editor
  const inputEvent = new InputEvent('input', {
    bubbles: true,
    composed: true,
    inputType: 'insertText',
    data: text
  });
  element.dispatchEvent(inputEvent);

  // Also dispatch change if needed
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

// Robust "enter"/submit behavior (no site-specific clicking)
function trySubmitClosestForm() {
  const el = document.activeElement;
  if (!el) return false;

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

function fallbackSendEnterKey() {
  const el = document.activeElement;
  if (!el || !isEditableTarget(el)) return;

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

function sendEnterAfterInsert() {
  // 1) Try actual form submit
  if (trySubmitClosestForm()) return;
  // 2) Fallback to synthetic Enter for non-form cases
  fallbackSendEnterKey();
}

// Futureproof recorder (unchanged from your last version)
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

// page bridge start/stop/abort (same as before)
window.addEventListener("message", async (event) => {
  if (!event.data) return;

  if (event.data.type === 'WHISPER_START_RECORDING') {
    if (processingSessionId !== null) return;
    if (captureActive) return;

    captureActive = true;
    currentSessionId += 1;
    activeSessionId = currentSessionId;

    try { browser.runtime.sendMessage({ type: 'RECORDING_START', sessionId: activeSessionId, hostname: location.hostname }); } catch (_) { }

    startRecording(event.data.language, activeSessionId);
  }
  else if (event.data.type === 'WHISPER_STOP_RECORDING') {
    if (captureActive) stopRecording(false);
  }
  else if (event.data.type === 'WHISPER_ABORT_RECORDING') {
    clearProcessingWatchdog();
    if (captureActive) {
      stopRecording(true);
      try { browser.runtime.sendMessage({ type: 'CANCEL_SESSION', sessionId: activeSessionId, hostname: location.hostname }); } catch (_) { }
    } else if (processingSessionId !== null) {
      try { browser.runtime.sendMessage({ type: 'CANCEL_SESSION', sessionId: processingSessionId, hostname: location.hostname }); } catch (_) { }
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

    const mimeType = pickBestRecorderMimeType();
    globalRecorder = mimeType ? new MediaRecorder(globalStream, { mimeType }) : new MediaRecorder(globalStream);

    globalChunks = [];
    skipTranscribe = false;

    globalContext = new AudioContext();
    const source = globalContext.createMediaStreamSource(globalStream);
    const analyser = globalContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
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
          browser.runtime.sendMessage({ type: 'RECORDING_STOP', sessionId, hostname: location.hostname, canceled: skipTranscribe });
        } catch (_) { }

        if (skipTranscribe) { captureActive = false; return; }
        if (duration < 300) { captureActive = false; return; }
        if (sessionId !== activeSessionId) { captureActive = false; return; }

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
            hostname: location.hostname
          });
        } catch (e) {
          clearProcessingWatchdog();
          processingSessionId = null;
          showNotification("Failed to send audio to background: " + (e?.message || e), "error");
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
    try { browser.runtime.sendMessage({ type: 'RECORDING_STOP', sessionId, hostname: location.hostname, canceled: true }); } catch (_) { }
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
  if (message.type === 'WHISPER_RESULT_TO_PAGE_BRIDGE') {
    clearProcessingWatchdog();
    processingSessionId = null;

    let text = fixEncoding(message.text);
    const now = Date.now();
    if (text === lastText && (now - lastTextTime < 2000)) return;
    lastText = text; lastTextTime = now;

    showNotification(text, "success");
    insertIntoActiveEditable(text);

    if (sendEnterAfterResult) {
      sendEnterAfterInsert(); // form submit first, then fallback
    }

    window.postMessage({ type: 'WHISPER_RESULT_TO_PAGE', text }, "*");
  }
  else if (message.type === 'WHISPER_NO_AUDIO') {
    clearProcessingWatchdog();
    processingSessionId = null;

    if (message.reason !== 'silence') showNotification("No speech detected", "info");
    else { const n = document.getElementById("whisper-pill"); if (n) n.style.opacity = "0"; }
  }
  else if (message.type === 'WHISPER_UNINTELLIGIBLE') {
    clearProcessingWatchdog();
    processingSessionId = null;
    showNotification("Didn't catch that", "error");
  }
  else if (message.type === 'WHISPER_ERROR') {
    clearProcessingWatchdog();
    processingSessionId = null;
    showNotification(message.error || "Transcription error", "error");
  }
});