// content.js - Ack-based icon state, modern UI & encoding fixes

if (window.self !== window.top) {
    throw new Error("Whisper: Skipping iframe execution.");
}

let silenceTimeoutMs = 1000;
let shouldShowNotifications = false;
let captureActive = false;
let currentSessionId = 0;
let activeSessionId = 0;
let recordingStartTime = 0;

let globalStream = null;
let globalContext = null;
let globalRecorder = null;
let globalChunks = [];
let skipTranscribe = false; // honor cancel/abort

async function resolveEffectiveSettings() {
    try {
        const hostname = location.hostname;
        const { settings } = await browser.storage.local.get('settings');
        shouldShowNotifications = settings?.debugMode === true;
        const defaults = settings?.defaults || { silenceTimeoutMs: 1000 };
        const overrides = settings?.overrides || {};
        const site = overrides[hostname] || {};
        silenceTimeoutMs = site.silenceTimeoutMs ?? defaults.silenceTimeoutMs ?? 1000;
    } catch (_) {
        silenceTimeoutMs = 1000;
        shouldShowNotifications = false;
    }
}
resolveEffectiveSettings();
browser.runtime.onMessage.addListener((message) => {
    if (message?.type === 'CONFIG_CHANGED') resolveEffectiveSettings();
});

// Inline polyfill with page-handled ack
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
      if (!this.isRecording) return;
      this.isRecording = false;
      window.postMessage({ type: 'WHISPER_STOP_RECORDING' }, "*");
      this.onend?.();
    }
    abort() {
      if (!this.isRecording) return;
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

// Bridge messages with ack
window.addEventListener("message", async (event) => {
  if (!event.data) return;
  if (event.data.type === 'WHISPER_START_RECORDING') {
      if (captureActive) return;
      captureActive = true;
      currentSessionId += 1;
      activeSessionId = currentSessionId;
      startRecording(event.data.language, activeSessionId);
  } else if (event.data.type === 'WHISPER_STOP_RECORDING') {
      stopRecording(false);
  } else if (event.data.type === 'WHISPER_ABORT_RECORDING') {
      stopRecording(true); // cancel: no transcription
  } else if (event.data.type === 'WHISPER_PAGE_HANDLED') {
      // Page handled the result; inform background to return to idle
      browser.runtime.sendMessage({ type: 'PROCESSING_DONE' });
  }
});

async function startRecording(pageLanguage, sessionId) {
    try {
        const langDisplay = pageLanguage ? pageLanguage.toUpperCase() : "AUTO";
        showNotification(`Listening (${langDisplay})...`, "recording");
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

        let silenceStart = Date.now();
        let isSpeaking = false;

        const checkSilence = () => {
            if (!captureActive || globalRecorder.state === 'inactive') return;
            analyser.getByteFrequencyData(dataArray);
            let sum = 0; for(let i=0; i<dataArray.length; i++) sum += dataArray[i];
            const avg = sum / dataArray.length;
            if (avg > 10) { silenceStart = Date.now(); isSpeaking = true; }
            else if (isSpeaking && (Date.now() - silenceStart > silenceTimeoutMs)) { stopRecording(false); return; }
            requestAnimationFrame(checkSilence);
        };
        checkSilence();

        globalRecorder.ondataavailable = event => globalChunks.push(event.data);

        globalRecorder.onstop = async () => {
            try {
                const duration = Date.now() - recordingStartTime;
                if (skipTranscribe) {
                    captureActive = false;
                    browser.runtime.sendMessage({ type: 'RECORDING_STATE', state: 'idle' });
                    return;
                }
                if (duration < 300) {
                    console.log("Whisper: Input aborted (too short).");
                    captureActive = false;
                    browser.runtime.sendMessage({ type: 'RECORDING_STATE', state: 'idle' });
                    return; 
                }
                showNotification("Processing...", "processing");
                if (sessionId !== activeSessionId) { captureActive = false; return; }
                const audioBlob = new Blob(globalChunks, { type: 'audio/wav' });
                const arrayBuffer = await audioBlob.arrayBuffer();
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
        setTimeout(() => { if (captureActive && sessionId === activeSessionId) stopRecording(false); }, 5000); 
    } catch (err) {
        captureActive = false;
        showNotification("Error: " + err.message, "error");
        browser.runtime.sendMessage({ type: 'RECORDING_STATE', state: 'idle' });
    }
}

function stopRecording(cancel = false) {
    skipTranscribe = cancel;
    if (globalStream) { globalStream.getTracks().forEach(track => track.stop()); globalStream = null; }
    if (globalContext && globalContext.state !== 'closed') { globalContext.close(); globalContext = null; }
    if (globalRecorder && globalRecorder.state !== 'inactive') { globalRecorder.stop(); }
    captureActive = false;
}

let lastTextTime = 0;
let lastText = "";

browser.runtime.onMessage.addListener((message) => {
    if (message.type === 'WHISPER_RESULT_TO_PAGE_BRIDGE') {
        let text = fixEncoding(message.text);
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
        if (message.reason !== 'silence') { showNotification("No speech detected", "info"); }
        else { const n = document.getElementById("whisper-pill"); if (n) n.style.opacity = "0"; }
        browser.runtime.sendMessage({ type: 'PROCESSING_DONE' });
    }
    else if (message.type === 'WHISPER_UNINTELLIGIBLE') {
        // Signal background to show red mic icon (unintelligible after processing)
        browser.runtime.sendMessage({ type: 'UNINTELLIGIBLE_SPEECH' });
    }
    else if (message.type === 'WHISPER_ERROR') {
        showNotification(message.error, "error");
        browser.runtime.sendMessage({ type: 'PROCESSING_DONE' });
    }
});