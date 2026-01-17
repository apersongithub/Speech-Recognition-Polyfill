// content.js - Ack-based icon state, modern UI & encoding fixes + debug logging

if (window.self !== window.top) {
    throw new Error("Whisper: Skipping iframe execution.");
}

let silenceTimeoutMs = 1000;
let shouldShowNotifications = false;
let captureActive = false;
let currentSessionId = 0;
let activeSessionId = 0;
let recordingStartTime = 0;
let processingSessionId = null; // track the session sent for processing
let disableHardCap = false;

let globalStream = null;
let globalContext = null;
let globalRecorder = null;
let globalChunks = [];
let skipTranscribe = false; // honor cancel/abort
let silenceCheckTimer = null;

function dbg(...args) {
    if (shouldShowNotifications) console.log('[Whisper DEBUG]', ...args);
}

async function resolveEffectiveSettings() {
    try {
        const hostname = location.hostname;
        const { settings } = await browser.storage.local.get('settings');
        shouldShowNotifications = settings?.debugMode === true;
        const defaults = settings?.defaults || { silenceTimeoutMs: 1000 };
        const overrides = settings?.overrides || {};
        const site = overrides[hostname] || {};
        silenceTimeoutMs = site.silenceTimeoutMs ?? defaults.silenceTimeoutMs ?? 1000;
        disableHardCap = settings?.disableHardCap === true;
        dbg('Settings resolved', { hostname, silenceTimeoutMs, disableHardCap, debug: shouldShowNotifications });
    } catch (_) {
        silenceTimeoutMs = 1000;
        shouldShowNotifications = false;
        disableHardCap = false;
    }
}
resolveEffectiveSettings();
browser.runtime.onMessage.addListener((message) => {
    if (message?.type === 'CONFIG_CHANGED') resolveEffectiveSettings();
});

// Inline polyfill with page-handled ack (stop/abort always send)
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
    dbg('Notification', { type, message });
    if (!shouldShowNotifications) return;
    const existing = document.getElementById("whisper-pill");
    if (existing) existing.remove();
    let bg = "rgba(15, 23, 42, 0.85)", icon = "✨";
    if (type === "processing") { bg = "rgba(245, 158, 11, 0.9)"; icon = "⚡"; }
    if (type === "success")    { bg = "rgba(22, 163, 74, 0.9)"; icon = "✅"; }
    if (type === "error")      { bg = "rgba(220, 38, 38, 0.9)"; icon = "⚠️"; }
    if (type === "recording")  { bg = "rgba(37, 99, 235, 0.9)"; icon = "🎙️"; }
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
    setTimeout(() => { if (div) { div.style.opacity = "0"; div.style.transform = "translateX(-50%) translateY(10px)"; setTimeout(() => div.remove(), 300); } }, duration);
}

// Bridge messages with ack + explicit cancel during processing (only on abort)
window.addEventListener("message", async (event) => {
  if (!event.data) return;
  if (event.data.type === 'WHISPER_START_RECORDING') {
      dbg('Start recording (page msg)', { language: event.data.language, processingSessionId });
      if (processingSessionId !== null) {
          browser.runtime.sendMessage({
              type: 'CANCEL_SESSION',
              sessionId: processingSessionId,
              hostname: location.hostname
          });
          processingSessionId = null;
      }
      if (captureActive) return;
      captureActive = true;
      currentSessionId += 1;
      activeSessionId = currentSessionId;
      startRecording(event.data.language, activeSessionId);
  } else if (event.data.type === 'WHISPER_STOP_RECORDING') {
      dbg('Stop recording (page msg)');
      if (captureActive) {
          stopRecording(false);
      }
      // no cancel here
  } else if (event.data.type === 'WHISPER_ABORT_RECORDING') {
      dbg('Abort recording (page msg)', { captureActive, processingSessionId });
      if (captureActive) {
          stopRecording(true);
          browser.runtime.sendMessage({
              type: 'CANCEL_SESSION',
              sessionId: activeSessionId,
              hostname: location.hostname
          });
      } else if (processingSessionId !== null) {
          browser.runtime.sendMessage({
              type: 'CANCEL_SESSION',
              sessionId: processingSessionId,
              hostname: location.hostname
          });
          processingSessionId = null;
      }
  } else if (event.data.type === 'WHISPER_PAGE_HANDLED') {
      dbg('Page handled result (page msg)');
      browser.runtime.sendMessage({ type: 'PROCESSING_DONE' });
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
        dbg('Recording started', { sessionId, pageLanguage, disableHardCap });
        browser.runtime.sendMessage({ type: 'RECORDING_STATE', state: 'recording' });

        recordingStartTime = Date.now();
        globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        globalRecorder = new MediaRecorder(globalStream);
        globalChunks = [];
        skipTranscribe = false;

        globalContext = new AudioContext();
        const source = globalContext.createMediaStreamSource(globalStream);
        const analyser = globalContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        let noiseFloor = 8; // adaptive baseline
        let lastHeard = Date.now();
        let everHeard = false;
        const startTime = Date.now();
        const maxNoSpeechMs = Math.max(2500, silenceTimeoutMs * 2.5); // if never heard speech
        const track = globalStream.getAudioTracks()[0];
        if (track) {
            track.onmute = () => { dbg('Track muted'); };
        }

        const checkSilence = () => {
            if (!captureActive || globalRecorder.state === 'inactive') return;

            analyser.getByteFrequencyData(dataArray);
            let sum = 0; for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
            const avg = sum / dataArray.length;

            // adapt noise floor slowly; cap it
            noiseFloor = Math.min(35, noiseFloor * 0.97 + avg * 0.03);
            const speechThreshold = noiseFloor + 12;
            const silenceThreshold = noiseFloor + 4;

            const now = Date.now();
            if (avg > speechThreshold) {
                lastHeard = now;
                everHeard = true;
            }

            const sinceHeard = now - lastHeard;

            if (shouldShowNotifications && (sinceHeard % 600 < 130)) {
                dbg('SilenceCheck', { avg: avg.toFixed(1), noiseFloor: noiseFloor.toFixed(1), speechThreshold, silenceThreshold, sinceHeard, everHeard });
            }

            // If never heard speech at all, stop after maxNoSpeechMs
            if (!everHeard && (now - startTime > maxNoSpeechMs)) {
                dbg('No speech detected within window, stopping.', { sinceStart: now - startTime, maxNoSpeechMs });
                stopRecording(false);
                return;
            }

            // After speech, stop on extended silence
            if (everHeard && avg < silenceThreshold && sinceHeard > silenceTimeoutMs) {
                dbg('Silence timeout hit, stopping.', { sinceHeard, silenceTimeoutMs, avg, silenceThreshold });
                stopRecording(false);
                return;
            }

            silenceCheckTimer = setTimeout(checkSilence, 120);
        };
        silenceCheckTimer = setTimeout(checkSilence, 120);

        globalRecorder.ondataavailable = event => globalChunks.push(event.data);

        globalRecorder.onstop = async () => {
            clearSilenceTimer();
            try {
                const duration = Date.now() - recordingStartTime;
                const bytes = globalChunks.reduce((acc, b) => acc + (b?.size || 0), 0);
                dbg('Recorder stop', { duration, skipTranscribe, sessionId, bytes });
                if (skipTranscribe) {
                    captureActive = false;
                    browser.runtime.sendMessage({ type: 'RECORDING_STATE', state: 'idle' });
                    return;
                }
                if (duration < 300) {
                    dbg('Too short, drop', { duration });
                    captureActive = false;
                    browser.runtime.sendMessage({ type: 'RECORDING_STATE', state: 'idle' });
                    return; 
                }
                showNotification("Processing...", "processing");
                if (sessionId !== activeSessionId) { captureActive = false; return; }
                const audioBlob = new Blob(globalChunks, { type: 'audio/wav' });
                const arrayBuffer = await audioBlob.arrayBuffer();
                processingSessionId = sessionId; // mark in-flight processing
                dbg('Send TRANSCRIBE_AUDIO', { sessionId, bytes: arrayBuffer.byteLength, pageLanguage });
                browser.runtime.sendMessage({
                    type: 'TRANSCRIBE_AUDIO',
                    sessionId,
                    audioData: Array.from(new Uint8Array(arrayBuffer)),
                    language: pageLanguage,
                    hostname: location.hostname
                });
            } catch (e) { console.error(e); } finally { captureActive = false; }
        };

        globalRecorder.start();
        if (!disableHardCap) {
            setTimeout(() => { if (captureActive && sessionId === activeSessionId) { dbg('Hard cap stop (5s)', { sessionId }); stopRecording(false); } }, 5000);
        }
    } catch (err) {
        clearSilenceTimer();
        captureActive = false;
        showNotification("Error: " + err.message, "error");
        browser.runtime.sendMessage({ type: 'RECORDING_STATE', state: 'idle' });
    }
}

function stopRecording(cancel = false) {
    clearSilenceTimer();
    skipTranscribe = cancel;
    if (globalStream) { globalStream.getTracks().forEach(track => track.stop()); globalStream = null; }
    if (globalContext && globalContext.state !== 'closed') { globalContext.close(); globalContext = null; }
    if (globalRecorder && globalRecorder.state !== 'inactive') { globalRecorder.stop(); }
    captureActive = false;
    dbg('stopRecording', { cancel, sessionId: activeSessionId });
}

let lastTextTime = 0;
let lastText = "";

browser.runtime.onMessage.addListener((message) => {
    if (message.type === 'WHISPER_RESULT_TO_PAGE_BRIDGE') {
        processingSessionId = null;
        let text = fixEncoding(message.text);
        dbg('Result to page', { text });
        const now = Date.now();
        if (text === lastText && (now - lastTextTime < 2000)) {
            console.warn("Whisper: Dropped duplicate text:", text);
            return;
        }
        lastText = text; lastTextTime = now;
        showNotification(text, "success");
        window.postMessage({ type: 'WHISPER_RESULT_TO_PAGE', text }, "*");
    }
    else if (message.type === 'WHISPER_NO_AUDIO') {
        processingSessionId = null;
        dbg('No audio', message);
        if (message.reason !== 'silence') { showNotification("No speech detected", "info"); }
        else { const n = document.getElementById("whisper-pill"); if (n) n.style.opacity = "0"; }
        browser.runtime.sendMessage({ type: 'PROCESSING_DONE', status: 'noaudio' });
    }
    else if (message.type === 'WHISPER_UNINTELLIGIBLE') {
        processingSessionId = null;
        dbg('Unintelligible');
        showNotification("Didn't catch that", "error");
        // Actively cancel/stop anything still in-flight
        browser.runtime.sendMessage({ type: 'CANCEL_SESSION', sessionId: activeSessionId || processingSessionId || 0, hostname: location.hostname });
        browser.runtime.sendMessage({ type: 'UNINTELLIGIBLE_SPEECH' });
        browser.runtime.sendMessage({ type: 'PROCESSING_DONE', status: 'noaudio' });
        browser.runtime.sendMessage({ type: 'RECORDING_STATE', state: 'idle' });
        stopRecording(true);
    }
    else if (message.type === 'WHISPER_ERROR') {
        processingSessionId = null;
        dbg('Error', message);
        showNotification(message.error, "error");
        browser.runtime.sendMessage({ type: 'PROCESSING_DONE', status: 'error' });
    }
});