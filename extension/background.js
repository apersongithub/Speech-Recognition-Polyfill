// background.js (MV2) - Firefox
// Worker-based local Whisper to allow freeing WASM/WebGPU resources by terminating the worker.
// Debug mode: can forward debug logs to the site console via content script.

import { env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.16.1';

env.allowLocalModels = false;
env.useBrowserCache = true;

const ALLOWED_MODELS = new Set([
  'Xenova/whisper-tiny.en',
  'Xenova/whisper-tiny',
  'Xenova/whisper-base.en',
  'Xenova/whisper-base',
  'Xenova/whisper-small.en',
  'Xenova/whisper-small',
  'Xenova/distil-whisper-medium.en'
]);

const PROVIDERS = {
  LOCAL: 'local-whisper',
  ASSEMBLY: 'assemblyai',
  VOSK: 'vosk'
};

const VOSK_MODELS = new Map([
  ['vosk-model-malayalam-bigram', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-malayalam-bigram.tar.gz'],
  ['vosk-model-small-ca-0.4', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-ca-0.4.tar.gz'],
  ['vosk-model-small-cn-0.3', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-cn-0.3.tar.gz'],
  ['vosk-model-small-de-0.15', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-de-0.15.tar.gz'],
  ['vosk-model-small-en-in-0.4', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-in-0.4.tar.gz'],
  ['vosk-model-small-en-us-0.15', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz'],
  ['vosk-model-small-es-0.3', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-es-0.3.tar.gz'],
  ['vosk-model-small-fa-0.4', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-fa-0.4.tar.gz'],
  ['vosk-model-small-fr-pguyot-0.3', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-fr-pguyot-0.3.tar.gz'],
  ['vosk-model-small-it-0.4', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-it-0.4.tar.gz'],
  ['vosk-model-small-pt-0.3', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-pt-0.3.tar.gz'],
  ['vosk-model-small-ru-0.4', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-ru-0.4.tar.gz'],
  ['vosk-model-small-tr-0.3', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-tr-0.3.tar.gz'],
  ['vosk-model-small-vn-0.3', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-vn-0.3.tar.gz'],
  ['vosk-model-en-us-0.22', 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-en-us-0.22.tar.gz']
]);

const DEFAULT_VOSK_MODEL = 'vosk-model-small-en-us-0.15';

const VOSK_MODEL_TIMEOUT_MS = 120000;
const VOSK_STOP_TIMEOUT_MS = 8000;

const VOSK_LRU_MAX = 2;

function normalizeVoskModel(id) {
  return VOSK_MODELS.has(id) ? id : DEFAULT_VOSK_MODEL;
}

const ASSEMBLYAI_STREAM_SAMPLE_RATE = 16000;
const ASSEMBLYAI_BEGIN_TIMEOUT_MS = 6000;
const ASSEMBLYAI_PENDING_CHUNKS_MAX = 20;

const ASSEMBLYAI_MULTILINGUAL_LANGS = new Set(['en', 'es', 'fr', 'de', 'it', 'pt']);

// Default model: base multilingual
let currentModel = 'Xenova/whisper-base';

// used only to serialize ENSURE_MODEL + show badges
let modelLoadPromise = null;

// Cache-default-model residency control:
let keepModelResident = false;
let residentModelId = null;

let keepVoskResident = false;
let residentVoskModelId = null;

// Track defaults so we can cancel sessions when model/provider changes
let lastDefaultsFingerprint = null;

// Per-tab processing state
const inflightByTab = new Map();
const canceledSessionsByTab = new Map();
const lastSessionByTab = new Map();
const processingTimeoutByTab = new Map();

// NEW: track content-script instance per tab+frame to prevent "stale session" after reload/navigation.
const pageInstanceByTabFrame = new Map(); // key: `${tabId}:${frameId}` -> pageInstanceId

// Per-tab toolbar icon state
const tabStateById = new Map();
const iconCache = new Map();
const ICON_CACHE_MAX = 48;

// Per-tab badge timers
const badgeTimerByTab = new Map();

const RESULT_GRACE_MS_DEFAULT = 450;

const PROCESSING_TIMEOUT_MS = 20000;
const ERROR_HOLD_MS = 2500;

const assemblyStopRequestedBySession = new Set();

const BADGE_MS = {
  cached: 900,
  downloading: 0,
  downloaded: 900,
  download_error: 1200,
  cloudprocessing: 0,
  cancel: 1200,
  done: 650
};

const MODEL_IDLE_UNLOAD_MS = 15_000;
let modelGcTimer = null;

// Debug mode (developer option)
let debugMode = false;

// Forward debug to the site's console (via content script). Still only when debugMode=true.
let forwardDebugToPageConsole = true;

// NEW: hard-cancel support for AssemblyAI
const assemblyAbortBySession = new Map(); // key: `${tabId}:${sessionId}`
const sessionKey = (tabId, sessionId) => `${tabId}:${sessionId}`;

const assemblyStreamingBySession = new Map();
const voskStreamInitPromise = new Map();
const voskPendingChunks = new Map();
const voskStreamReady = new Set();

const voskModels = new Map(); // modelId -> { model, lastUsed }
const voskModelLoadPromises = new Map();
const voskRecognizers = new Map(); // sessionId -> { recognizer, tabId, frameId, modelId }

// NEW: keep-alive flag while Vosk models download
let voskDownloadsInProgress = 0;

// NEW: disable processing timeouts
let disableProcessingTimeouts = false;

function getActiveVoskModelIds() {
  const active = new Set();
  for (const entry of voskRecognizers.values()) {
    if (entry?.modelId) active.add(entry.modelId);
  }
  return active;
}

function touchVoskModel(modelId) {
  const entry = voskModels.get(modelId);
  if (entry) entry.lastUsed = Date.now();
}

async function disposeVoskModel(modelId, reason = 'gc') {
  const entry = voskModels.get(modelId);
  if (!entry) return;

  try { entry.model?.terminate?.(); } catch (_) { }
  try { entry.model?.dispose?.(); } catch (_) { }

  voskModels.delete(modelId);
  dbg('vosk_model_disposed', { modelId, reason });
}

function trimVoskModelCache({ forceIdle = false } = {}) {
  const active = getActiveVoskModelIds();

  if (forceIdle) {
    for (const modelId of [...voskModels.keys()]) {
      if (keepVoskResident && modelId === residentVoskModelId) continue;
      if (active.has(modelId)) continue;
      disposeVoskModel(modelId, 'idle_gc');
    }
    return;
  }

  if (voskModels.size <= VOSK_LRU_MAX) return;

  const entries = [...voskModels.entries()]
    .sort((a, b) => (a[1]?.lastUsed || 0) - (b[1]?.lastUsed || 0));

  for (const [modelId] of entries) {
    if (voskModels.size <= VOSK_LRU_MAX) break;
    if (active.has(modelId)) continue;
    if (keepVoskResident && modelId === residentVoskModelId) continue;
    disposeVoskModel(modelId, 'lru');
  }
}

async function ensureVoskModel(modelId) {
  const safeId = normalizeVoskModel(modelId);
  const existing = voskModels.get(safeId);

  if (existing?.model?.ready) {
    touchVoskModel(safeId);
    return { modelId: safeId, model: existing.model, cached: true };
  }

  const inflight = voskModelLoadPromises.get(safeId);
  if (inflight) {
    await inflight;
    const ready = voskModels.get(safeId);
    if (ready?.model?.ready) {
      touchVoskModel(safeId);
      return { modelId: safeId, model: ready.model, cached: false };
    }
  }

  const url = VOSK_MODELS.get(safeId);
  if (!url) throw new Error(`Unknown Vosk model: ${safeId}`);

  const loadPromise = (async () => {
    voskDownloadsInProgress += 1;
    try {
      const model = await Vosk.createModel(url);
      return model;
    } finally {
      voskDownloadsInProgress = Math.max(0, voskDownloadsInProgress - 1);
    }
  })();

  voskModelLoadPromises.set(safeId, loadPromise);

  try {
    const model = await loadPromise;
    voskModels.set(safeId, { model, lastUsed: Date.now() });
    trimVoskModelCache();
    return { modelId: safeId, model, cached: false };
  } finally {
    voskModelLoadPromises.delete(safeId);
  }
}

function startVoskStream(sessionId, tabId, frameId, sampleRate = 16000, graceEnabled = false, graceMs = 0, modelId = null, model = null) {
  const modelInstance = model || voskModels.get(modelId)?.model;
  if (!modelInstance || !modelInstance.ready) {
    throw new Error('Vosk model not ready');
  }

  console.log('[Vosk Direct] Creating recognizer for session:', sessionId);

  const KaldiRecognizer = modelInstance.KaldiRecognizer;
  const recognizer = new KaldiRecognizer(sampleRate);

  recognizer.on('result', (message) => {
    const text = message?.result?.text || '';
    console.log('[Vosk Direct] Result:', text);
    if (text) {
      const send = () => {
        sendTerminal(tabId, frameId, {
          type: 'WHISPER_RESULT_TO_PAGE_BRIDGE',
          text: text.trim(),
          sessionId,
          isFinal: true
        });
      };
      if (graceEnabled) setTimeout(send, graceMs);
      else send();
    }
  });

  recognizer.on('partialresult', (message) => {
    const text = message?.result?.partial || '';
    console.log('[Vosk Direct] Partial:', text);
    if (text) {
      sendTerminal(tabId, frameId, {
        type: 'WHISPER_RESULT_TO_PAGE_BRIDGE',
        text: text.trim(),
        sessionId,
        isFinal: false
      });
    }
  });

  voskRecognizers.set(sessionId, { recognizer, tabId, frameId, modelId });
  touchVoskModel(modelId);
  console.log('[Vosk Direct] Recognizer created and stored');
  return recognizer;
}

function sendVoskChunk(sessionId, audioData) {
  const entry = voskRecognizers.get(sessionId);
  if (!entry) {
    console.warn('[Vosk Direct] No recognizer for session:', sessionId);
    return;
  }

  const { recognizer } = entry;

  // Convert ArrayBuffer to Float32Array if needed
  let float32;
  if (audioData instanceof ArrayBuffer) {
    float32 = new Float32Array(audioData);
  } else if (audioData instanceof Float32Array) {
    float32 = audioData;
  } else {
    console.error('[Vosk Direct] Invalid audio data type');
    return;
  }

  // vosk-browser's acceptWaveformFloat expects Float32Array and sample rate
  recognizer.acceptWaveformFloat(float32, 16000);
}

function stopVoskStream(sessionId) {
  const entry = voskRecognizers.get(sessionId);
  if (!entry) {
    console.log('[Vosk Direct] No recognizer to stop for session:', sessionId);
    return;
  }

  const { recognizer, modelId } = entry;

  try {
    recognizer.retrieveFinalResult();
  } catch (err) {
    console.warn('[Vosk Direct] Error getting final result:', err);
  }

  try {
    recognizer.remove();
  } catch (err) {
    console.warn('[Vosk Direct] Error removing recognizer:', err);
  }

  voskRecognizers.delete(sessionId);
  if (modelId) touchVoskModel(modelId);
  trimVoskModelCache();
  console.log('[Vosk Direct] Stream stopped for session:', sessionId);
}

function dbg(tag, data = {}) {
  if (!debugMode) return;
  try { console.debug('[Whisper BG]', tag, data); } catch (_) { }
}

function dbgToTab(tabId, frameId, tag, data = {}) {
  if (!debugMode) return;
  if (!forwardDebugToPageConsole) return;
  if (tabId == null) return;

  try {
    browser.tabs.sendMessage(tabId, { type: 'WHISPER_DEBUG_LOG', tag, data, ts: Date.now() }, { frameId });
  } catch (_) { }
}

function tabFrameKey(tabId, frameId) {
  const fid = (typeof frameId === 'number') ? frameId : 0;
  return `${tabId}:${fid}`;
}

async function onMessageMaybeResetEpoch(tabId, frameId, pageInstanceId, hostname) {
  if (tabId == null) return;

  const key = tabFrameKey(tabId, frameId);
  if (!pageInstanceId) {
    return;
  }

  const prev = pageInstanceByTabFrame.get(key);
  if (prev && prev !== pageInstanceId) {
    dbg('page_instance_changed_reset', { tabId, frameId, hostname, prev, next: pageInstanceId });

    lastSessionByTab.delete(tabId);

    const inflight = inflightByTab.get(tabId);
    if (inflight?.sessionId) markCanceled(tabId, inflight.sessionId);
    inflightByTab.delete(tabId);
    clearProcessingTimeout(tabId);

    try { await clearBadge(tabId); } catch (_) { }
    try { await setTabState(tabId, 'idle', null); } catch (_) { }
  }

  pageInstanceByTabFrame.set(key, pageInstanceId);
}

// ---------------- ASR Worker (WASM/WebGPU isolation) ----------------
let asrWorker = null;
let asrSeq = 1;
const asrInflight = new Map();

function ensureAsrWorker() {
  if (asrWorker) return;

  asrWorker = new Worker(browser.runtime.getURL('asr-worker.js'), { type: 'module' });

  asrWorker.onmessage = (ev) => {
    const msg = ev.data || {};
    const h = asrInflight.get(msg.id);
    if (!h) return;
    asrInflight.delete(msg.id);
    if (h.timeout) clearTimeout(h.timeout);
    if (msg.ok) h.resolve(msg);
    else h.reject(new Error(msg.error || 'Worker error'));
  };

  asrWorker.onerror = (e) => {
    dbg('asr_worker_error', { message: e?.message || String(e) });

    for (const [id, h] of asrInflight.entries()) {
      asrInflight.delete(id);
      if (h.timeout) clearTimeout(h.timeout);
      h.reject(new Error('ASR worker crashed'));
    }
    try { asrWorker.terminate(); } catch (_) { }
    asrWorker = null;
  };
}

function callAsrWorker(type, payload = {}, timeoutMs = PROCESSING_TIMEOUT_MS, transfer = []) {
  ensureAsrWorker();
  const id = asrSeq++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      asrInflight.delete(id);
      reject(new Error('ASR worker call timed out'));
    }, timeoutMs);

    asrInflight.set(id, { resolve, reject, timeout });
    try {
      asrWorker.postMessage({ id, type, ...payload }, transfer);
    } catch (e) {
      clearTimeout(timeout);
      asrInflight.delete(id);
      reject(e);
    }
  });
}

async function terminateAsrWorker() {
  if (!asrWorker) return;

  dbg('asr_worker_terminate', {});
  try { asrWorker.terminate(); } catch (_) { }
  asrWorker = null;

  for (const [id, h] of asrInflight.entries()) {
    asrInflight.delete(id);
    if (h.timeout) clearTimeout(h.timeout);
    h.reject(new Error('ASR worker terminated'));
  }
}

// ---------------- Vosk Worker (Streaming) ----------------
let voskWorker = null;
let voskSeq = 1;
const voskInflight = new Map();
const voskStreamingBySession = new Map();

function ensureVoskWorker() {
  if (voskWorker) return;

  voskWorker = new Worker(browser.runtime.getURL('vosk-worker.js'));

  voskWorker.onmessage = (ev) => {
    const msg = ev.data || {};
    if (typeof msg.id === 'number') {
      const h = voskInflight.get(msg.id);
      if (!h) return;
      voskInflight.delete(msg.id);
      if (h.timeout) clearTimeout(h.timeout);
      if (msg.ok) h.resolve(msg);
      else h.reject(new Error(msg.error || 'Vosk worker error'));
      return;
    }

    if (msg.type === 'VOSK_PARTIAL' || msg.type === 'VOSK_RESULT') {
      let session = null;

      if (msg.tabId != null) {
        session = voskStreamingBySession.get(sessionKey(msg.tabId, msg.sessionId));
      }

      if (!session) {
        for (const s of voskStreamingBySession.values()) {
          if (s.sessionId === msg.sessionId) { session = s; break; }
        }
      }

      if (!session) return;

      sendTerminal(session.tabId, session.frameId, {
        type: 'WHISPER_RESULT_TO_PAGE_BRIDGE',
        text: msg.text || '',
        sessionId: msg.sessionId,
        isFinal: msg.type === 'VOSK_RESULT'
      });
    }
  };

  voskWorker.onerror = (e) => {
    dbg('vosk_worker_error', { message: e?.message || String(e) });
    for (const [id, h] of voskInflight.entries()) {
      voskInflight.delete(id);
      if (h.timeout) clearTimeout(h.timeout);
      h.reject(new Error('Vosk worker crashed'));
    }
    try { voskWorker.terminate(); } catch (_) { }
    voskWorker = null;
  };
}

function callVoskWorker(type, payload = {}, timeoutMs = PROCESSING_TIMEOUT_MS) {
  ensureVoskWorker();
  const id = voskSeq++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      voskInflight.delete(id);
      reject(new Error('Vosk worker call timed out'));
    }, timeoutMs);

    voskInflight.set(id, { resolve, reject, timeout });
    try {
      voskWorker.postMessage({ id, type, ...payload });
    } catch (e) {
      clearTimeout(timeout);
      voskInflight.delete(id);
      reject(e);
    }
  });
}

function postVoskWorker(type, payload = {}) {
  ensureVoskWorker();
  try {
    voskWorker.postMessage({ type, ...payload });
  } catch (e) {
    dbg('vosk_post_error', { message: e?.message || String(e) });
  }
}

async function terminateVoskWorker() {
  if (!voskWorker) return;
  try { voskWorker.terminate(); } catch (_) { }
  voskWorker = null;

  for (const [id, h] of voskInflight.entries()) {
    voskInflight.delete(id);
    if (h.timeout) clearTimeout(h.timeout);
    h.reject(new Error('Vosk worker terminated'));
  }
}

// ---------------- Runtime flags ----------------
async function refreshRuntimeFlagsFromStorage() {
  try {
    const { settings } = await browser.storage.local.get('settings');
    debugMode = settings?.debugMode === true;
    disableProcessingTimeouts = settings?.disableProcessingTimeouts === true;

    const cacheDefaultModel = settings?.cacheDefaultModel === true;
    const defaults = settings?.defaults || {};
    const provider = (defaults.provider === PROVIDERS.ASSEMBLY) ? PROVIDERS.ASSEMBLY
      : (defaults.provider === PROVIDERS.VOSK ? PROVIDERS.VOSK : PROVIDERS.LOCAL);

    const model = (defaults.model && ALLOWED_MODELS.has(defaults.model))
      ? defaults.model
      : 'Xenova/whisper-base';

    const voskModel = normalizeVoskModel(defaults.voskModel || DEFAULT_VOSK_MODEL);

    keepModelResident = !!(cacheDefaultModel && provider === PROVIDERS.LOCAL && ALLOWED_MODELS.has(model));
    residentModelId = keepModelResident ? model : null;

    keepVoskResident = !!(cacheDefaultModel && provider === PROVIDERS.VOSK);
    residentVoskModelId = keepVoskResident ? voskModel : null;

    dbg('runtime_flags', { debugMode, keepModelResident, residentModelId, keepVoskResident, residentVoskModelId, provider, model, voskModel });
  } catch (_) {
    debugMode = false;
    disableProcessingTimeouts = false;
    keepModelResident = false;
    residentModelId = null;
    keepVoskResident = false;
    residentVoskModelId = null;
  }

  if (voskStreamInitPromise.size === 0 && voskStreamingBySession.size === 0) {
    if (!keepModelResident && !keepVoskResident) scheduleModelGc();
  }
}

// Theme-aware colors
const isDarkMode = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

const ICON_COLORS = () => ({
  idle: isDarkMode() ? '#e5e7eb' : '#374151',
  recording: '#2563eb',
  processing: '#f59e0b',
  error: '#dc2626',

  downloading: '#3b82f6',
  downloaded: '#16a34a',
  download_error: '#dc2626',

  cached: '#0ea5e9',
  cloudprocessing: '#0ea5e9',
  done: '#16a34a',
  cancel: '#ef4444',

  // NEW: disabled badge color (orange)
  disabled: '#f97316'
});

function badgePathForType(type) {
  if (type === 'cached') return 'images/cached.svg';
  if (type === 'done') return 'images/check.svg';
  if (type === 'cancel') return 'images/cancel.svg';
  if (type === 'cloudprocessing') return 'images/cloudprocessing.svg';
  if (type === 'disabled') return 'images/disabled.svg'; // NEW
  return 'images/downmodel.svg';
}

window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', async () => {
  try {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (tab?.id == null) continue;
      await ensureTabIconInitialized(tab.id);
    }
  } catch (_) { }
});

function t(key, fallback) {
  return (browser.i18n && browser.i18n.getMessage(key)) || fallback;
}

function applyDisabledBadge(tabId, isDisabled) {
  if (tabId == null) return;
  const ts = getTabState(tabId);

  if (isDisabled) {
    showBadgeForTab(
      tabId,
      { type: 'disabled', color: ICON_COLORS().disabled },
      0
    );
    return;
  }

  if (ts.badge?.type === 'disabled') {
    ts.badge = null;
    applyIconForTab(tabId).catch(() => { });
  }
}

async function updateDisabledBadgesForAllTabs() {
  const { settings } = await browser.storage.local.get('settings');
  const tabs = await browser.tabs.query({});

  for (const tab of tabs) {
    if (tab?.id == null || !tab.url) continue;
    let host = '';
    try { host = new URL(tab.url).hostname; } catch { host = ''; }
    const disabled = isHostDisabled(settings, host);
    applyDisabledBadge(tab.id, disabled);
  }
}

// ---------------- LRU icon cache helpers ----------------
function lruGet(key) {
  const entry = iconCache.get(key);
  if (!entry) return null;
  entry.ts = Date.now();
  return entry.value;
}

function lruSet(key, value) {
  iconCache.set(key, { value, ts: Date.now() });
  if (iconCache.size <= ICON_CACHE_MAX) return;

  let oldestKey = null;
  let oldestTs = Infinity;
  for (const [k, v] of iconCache.entries()) {
    if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
  }
  if (oldestKey) iconCache.delete(oldestKey);
}

// ---------------- Icon rendering helpers ----------------
function forceSvgFill(svgText, color) {
  let s = svgText
    .replace(/fill="context-fill"/gi, `fill="${color}"`)
    .replace(/fill='context-fill'/gi, `fill="${color}"`)
    .replace(/fill="currentColor"/gi, `fill="${color}"`)
    .replace(/fill='currentColor'/gi, `fill="${color}"`)
    .replace(/fill-opacity="context-fill-opacity"/gi, `fill-opacity="1"`)
    .replace(/fill-opacity='context-fill-opacity'/gi, `fill-opacity="1"`);

  if (!/\<svg[^>]*\sfill=/.test(s)) {
    s = s.replace('<svg', `<svg fill="${color}"`);
  }
  return s;
}

async function fetchSvg(path, color) {
  const raw = await (await fetch(browser.runtime.getURL(path))).text();
  return forceSvgFill(raw, color);
}

function drawSquircle(ctx, x, y, w, h) {
  const k = 0.45;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.5, y);
  ctx.bezierCurveTo(x + w * (0.5 + k), y, x + w, y + h * (0.5 - k), x + w, y + h * 0.5);
  ctx.bezierCurveTo(x + w, y + h * (0.5 + k), x + w * (0.5 + k), y + h, x + w * 0.5, y + h);
  ctx.bezierCurveTo(x + w * (0.5 - k), y + h, x, y + h * (0.5 + k), x, y + h * 0.5);
  ctx.bezierCurveTo(x, y + h * (0.5 - k), x + w * (0.5 - k), y, x + w * 0.5, y);
  ctx.closePath();
}

async function getIconImageData(baseColor, badge) {
  const badgeKey = badge ? `${badge.type}:${badge.color}` : 'none';
  const cacheKey = `mic:${baseColor}:badge:${badgeKey}`;
  const cached = lruGet(cacheKey);
  if (cached) return cached;

  const micSvg = await fetchSvg('images/microphone.svg', baseColor);
  const micUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(micSvg);

  const micImg = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = micUrl;
  });

  let badgeImg = null;
  if (badge) {
    const badgeSvg = await fetchSvg(badgePathForType(badge.type), badge.color);
    const badgeUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(badgeSvg);
    badgeImg = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = badgeUrl;
    });
  }

  const sizes = [16, 19, 32, 38];
  const out = {};
  for (const size of sizes) {
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(micImg, 0, 0, size, size);

    if (badgeImg) {
      const badgeSize = Math.round(size * 0.5);
      const padding = Math.round(size * 0.08);
      const x = size - badgeSize - padding;
      const y = size - badgeSize - padding;

      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = Math.max(1, Math.round(size * 0.08));
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      drawSquircle(ctx, x, y, badgeSize, badgeSize);
      ctx.fillStyle = '#0f172a';
      ctx.globalAlpha = 0.82;
      ctx.fill();
      ctx.restore();

      ctx.drawImage(badgeImg, x, y, badgeSize, badgeSize);
    }

    out[size] = ctx.getImageData(0, 0, size, size);
  }

  lruSet(cacheKey, out);
  return out;
}

// ---------------- Per-tab icon state ----------------
function getTabState(tabId) {
  if (!tabStateById.has(tabId)) {
    tabStateById.set(tabId, { state: 'idle', badge: null, errorHoldUntil: 0 });
  }
  return tabStateById.get(tabId);
}

function computeTitle(state) {
  if (state === 'recording') return t('title_recording', 'Whisper: Listening');
  if (state === 'processing') return t('title_processing', 'Whisper: Processing');
  if (state === 'error') return t('title_error', 'Whisper: Error');
  return t('title_idle', 'Whisper: Idle');
}

function computeColor(state) {
  const c = ICON_COLORS();
  if (state === 'recording') return c.recording;
  if (state === 'processing') return c.processing;
  if (state === 'error') return c.error;
  return c.idle;
}

async function applyIconForTab(tabId) {
  const ts = getTabState(tabId);
  const now = Date.now();

  let effectiveState = ts.state;
  const isActive = effectiveState === 'recording' || effectiveState === 'processing';
  if (!isActive && ts.errorHoldUntil > now && effectiveState !== 'error') {
    effectiveState = 'error';
  }

  const color = computeColor(effectiveState);
  const title = computeTitle(effectiveState);

  const images = await getIconImageData(color, ts.badge);
  await browser.browserAction.setIcon({ tabId, imageData: images });
  await browser.browserAction.setTitle({ tabId, title });
}

async function setTabState(tabId, state, badge = null) {
  const ts = getTabState(tabId);
  const now = Date.now();

  if (state === 'recording' || state === 'processing') {
    ts.errorHoldUntil = 0;
  } else if (ts.errorHoldUntil > now && state !== 'error') {
    return;
  }

  ts.state = state;
  ts.badge = badge;
  await applyIconForTab(tabId);
}

async function clearBadge(tabId) {
  const ts = tabStateById.get(tabId);
  if (!ts) return;

  const timer = badgeTimerByTab.get(tabId);
  if (timer) {
    clearTimeout(timer);
    badgeTimerByTab.delete(tabId);
  }

  if (ts.badge) {
    ts.badge = null;
    await applyIconForTab(tabId);
  }
}

async function setTabErrorHold(tabId, ms = ERROR_HOLD_MS) {
  const ts = getTabState(tabId);
  ts.errorHoldUntil = Date.now() + ms;
  ts.state = 'error';
  ts.badge = null;
  await applyIconForTab(tabId);

  setTimeout(async () => {
    const t2 = getTabState(tabId);
    if (t2.errorHoldUntil > Date.now()) return;
    t2.errorHoldUntil = 0;
    if (t2.state === 'error') {
      t2.state = 'idle';
      t2.badge = null;
      await applyIconForTab(tabId);
    }
  }, ms);
}

function showBadgeForTab(tabId, badge, ms) {
  const ts = getTabState(tabId);
  ts.badge = badge;
  applyIconForTab(tabId).catch(() => { });

  const prevTimer = badgeTimerByTab.get(tabId);
  if (prevTimer) {
    clearTimeout(prevTimer);
    badgeTimerByTab.delete(prevTimer);
  }

  if (ms > 0) {
    const timer = setTimeout(() => {
      const t2 = tabStateById.get(tabId);
      if (!t2) return;
      if (t2.badge && t2.badge.type === badge.type) {
        t2.badge = null;
        applyIconForTab(tabId).catch(() => { });
      }
      badgeTimerByTab.delete(tabId);
    }, ms);
    badgeTimerByTab.set(tabId, timer);
  }
}

async function ensureTabIconInitialized(tabId) {
  getTabState(tabId);
  try { await applyIconForTab(tabId); } catch (_) { }
}

// ---------------- Transaction helpers ----------------
function markCanceled(tabId, sessionId) {
  if (!tabId || !sessionId) return;
  let set = canceledSessionsByTab.get(tabId);
  if (!set) { set = new Set(); canceledSessionsByTab.set(tabId, set); }
  set.add(sessionId);
}

function isCanceled(tabId, sessionId) {
  const set = canceledSessionsByTab.get(tabId);
  return !!(set && set.has(sessionId));
}

function clearProcessingTimeout(tabId) {
  const t = processingTimeoutByTab.get(tabId);
  if (t) clearTimeout(t);
  processingTimeoutByTab.delete(tabId);
}

function armProcessingTimeout(tabId, sessionId, frameId) {
  clearProcessingTimeout(tabId);
  if (disableProcessingTimeouts) return;

  const timer = setTimeout(async () => {
    const inflight = inflightByTab.get(tabId);
    if (!inflight || inflight.sessionId !== sessionId) return;

    try {
      browser.tabs.sendMessage(tabId, { type: 'WHISPER_ERROR', error: 'Processing timed out' }, { frameId });
    } catch (_) { }

    inflightByTab.delete(tabId);
    clearProcessingTimeout(tabId);

    await clearBadge(tabId);
    await setTabErrorHold(tabId, ERROR_HOLD_MS);
    scheduleModelGc();
  }, PROCESSING_TIMEOUT_MS);

  processingTimeoutByTab.set(tabId, timer);
}

function coerceAudioData(audioData) {
  if (!audioData) return null;
  if (audioData instanceof ArrayBuffer) return audioData;
  if (audioData?.buffer instanceof ArrayBuffer) return audioData.buffer;
  if (Array.isArray(audioData)) return new Uint8Array(audioData).buffer;
  return null;
}

function sendTerminal(tabId, frameId, payload) {
  try {
    const p = browser.tabs.sendMessage(tabId, payload, { frameId });
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
    }
  } catch (_) { }
}

// ---------- Model / GC / Prefetch (worker-based) ----------
async function disposeCurrentModel() {
  if (!asrWorker) return;
  try { await callAsrWorker('DISPOSE_MODEL', {}, 10_000); } catch (_) { }
}

function scheduleModelGc() {
  // Don't GC if keeping resident model
  if (keepModelResident && residentModelId) {
    if (modelGcTimer) { clearTimeout(modelGcTimer); modelGcTimer = null; }
    dbg('gc_skip_resident_default', { residentModelId });
    return;
  }
  if (keepVoskResident && residentVoskModelId) {
    if (modelGcTimer) { clearTimeout(modelGcTimer); modelGcTimer = null; }
    dbg('gc_skip_resident_vosk', { residentVoskModelId });
    return;
  }

  if (voskDownloadsInProgress > 0) {
    dbg('gc_skip_vosk_download', { count: voskDownloadsInProgress });
    return;
  }

  if (modelGcTimer) clearTimeout(modelGcTimer);
  modelGcTimer = setTimeout(async () => {
    // Don't GC if there's active processing
    if (inflightByTab.size > 0) return;
    if (modelLoadPromise) return;
    if (keepModelResident && residentModelId) return;
    if (keepVoskResident && residentVoskModelId) return;
    if (voskDownloadsInProgress > 0) return;

    // NEW: Don't GC if Vosk streams are initializing or active
    if (voskStreamInitPromise.size > 0) {
      dbg('gc_skip_vosk_initializing', { count: voskStreamInitPromise.size });
      return;
    }
    if (voskStreamingBySession.size > 0) {
      dbg('gc_skip_vosk_active', { count: voskStreamingBySession.size });
      return;
    }
    if (voskModelLoadPromises.size > 0) return;

    await disposeCurrentModel();
    await terminateAsrWorker();
    await terminateVoskWorker();

    trimVoskModelCache({ forceIdle: true });

    dbg('worker_terminated_idle', { afterMs: MODEL_IDLE_UNLOAD_MS });
  }, MODEL_IDLE_UNLOAD_MS);
}

async function getEffectiveSettings(hostname) {
  const { settings } = await browser.storage.local.get('settings');
  const defaults = settings?.defaults || { model: 'Xenova/whisper-base', language: 'auto', provider: PROVIDERS.VOSK };
  const graceEnabled = settings?.graceEnabled !== false;
  const graceMs = typeof settings?.graceMs === 'number' ? settings.graceMs : RESULT_GRACE_MS_DEFAULT;
  const assemblyaiApiKey = settings?.assemblyaiApiKey || null;

  const baseProvider = (defaults.provider === PROVIDERS.ASSEMBLY) ? PROVIDERS.ASSEMBLY
    : (defaults.provider === PROVIDERS.LOCAL ? PROVIDERS.LOCAL : PROVIDERS.VOSK);

  const overrides = settings?.overrides || {};
  const host = normalizeHost(hostname);
  const site = host ? (overrides[host] || {}) : {};
  const provider = (site.provider ?? baseProvider) === PROVIDERS.ASSEMBLY
    ? PROVIDERS.ASSEMBLY
    : ((site.provider ?? baseProvider) === PROVIDERS.VOSK ? PROVIDERS.VOSK : PROVIDERS.LOCAL);

  const disabled = isHostDisabled(settings, host);
  const siteGraceMs = typeof site.graceMs === 'number' ? site.graceMs : null;

  const whisperModel = (site.model && ALLOWED_MODELS.has(site.model))
    ? site.model
    : (ALLOWED_MODELS.has(defaults.model) ? defaults.model : 'Xenova/whisper-base');

  const voskModel = normalizeVoskModel(site.model || defaults.voskModel || DEFAULT_VOSK_MODEL);

  return {
    enabled: !disabled,
    model: provider === PROVIDERS.VOSK ? voskModel : whisperModel,
    language: site.language ?? defaults.language ?? 'auto',
    graceEnabled,
    graceMs: (siteGraceMs ?? graceMs),
    provider,
    assemblyaiApiKey,
    assemblyaiStreamingEnabled: settings?.assemblyaiStreamingEnabled !== false,
    assemblyaiStreamingMultilingualEnabled: settings?.assemblyaiStreamingMultilingualEnabled !== false
  };
}

async function ensureModelSilently(modelID) {
  const safeModel = ALLOWED_MODELS.has(modelID) ? modelID : 'Xenova/whisper-base';
  await callAsrWorker('ENSURE_MODEL', { modelID: safeModel }, PROCESSING_TIMEOUT_MS);
  currentModel = safeModel;
}

async function ensureModelForTab(tabId, modelID) {
  const safeModel = ALLOWED_MODELS.has(modelID) ? modelID : 'Xenova/whisper-base';
  const colors = ICON_COLORS();

  showBadgeForTab(tabId, { type: 'download', color: colors.downloading }, BADGE_MS.downloading);

  modelLoadPromise = (async () => {
    return await callAsrWorker('ENSURE_MODEL', { modelID: safeModel }, PROCESSING_TIMEOUT_MS);
  })();

  try {
    const res = await modelLoadPromise;
    currentModel = res.model || safeModel;

    if (res.cached) {
      showBadgeForTab(tabId, { type: 'cached', color: colors.cached }, BADGE_MS.cached);
    } else {
      showBadgeForTab(tabId, { type: 'download', color: colors.downloaded }, BADGE_MS.downloaded);
    }

    dbgToTab(tabId, 0, 'model_backend', { backend: res.backend || 'unknown' });
  } catch (e) {
    showBadgeForTab(tabId, { type: 'download', color: colors.download_error }, BADGE_MS.download_error);
    throw e;
  } finally {
    modelLoadPromise = null;
  }
}

async function prefetchDefaultModelIfEnabled() {
  if (keepModelResident && residentModelId) {
    try {
      dbg('prefetch_start', { model: residentModelId });
      await ensureModelSilently(residentModelId);
      dbg('prefetch_done', { model: residentModelId });
    } catch (e) {
      dbg('prefetch_failed', { error: String(e) });
    }
  }

  if (keepVoskResident && residentVoskModelId) {
    try {
      dbg('prefetch_vosk_start', { model: residentVoskModelId });
      await ensureVoskModel(residentVoskModelId);
      dbg('prefetch_vosk_done', { model: residentVoskModelId });
    } catch (e) {
      dbg('prefetch_vosk_failed', { error: String(e) });
    }
  }
}

// ---------- Audio ----------
async function readAudio(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext({ sampleRate: 16000 });
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    return new Float32Array(audioBuffer.getChannelData(0));
  } finally {
    try { await audioContext.close(); } catch (_) { }
  }
}

function trimSilence(audioData, sampleRate = 16000) {
  const threshold = 0.01;
  let start = 0, end = audioData.length;
  for (let i = 0; i < audioData.length; i++) { if (Math.abs(audioData[i]) > threshold) { start = i; break; } }
  for (let i = audioData.length - 1; i >= start; i--) { if (Math.abs(audioData[i]) > threshold) { end = i + 1; break; } }
  const trimmed = audioData.subarray(start, end);
  if (trimmed.length < sampleRate * 0.2) return null;
  return trimmed;
}

// ---------- settings / assembly ----------
function collapseRepeats(text) {
  const words = text.trim().split(/\s+/);
  const out = [];
  let last = null, run = 0;
  for (const w of words) {
    if (w === last) { run += 1; if (run <= 3) out.push(w); }
    else { last = w; run = 1; out.push(w); }
  }
  let collapsed = out.join(' ');
  collapsed = collapsed.replace(/(\b[\w\.\-]{1,8}\b)(\s+\1){4,}/gi, '$1 $1 $1');
  return collapsed.trim();
}

function isPathological(text) {
  if (!text) return true;
  const tokens = text.split(/\s+/);
  const unique = new Set(tokens);
  return (text.length > 80 && unique.size <= 3) || tokens.length === 0;
}

function isSpammyRepetition(text) {
  if (!text) return true;
  const s = text.trim();
  if (s.length < 8) return false;

  let maxRun = 1;
  let currentRun = 1;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === s[i - 1]) {
      currentRun += 1;
      if (currentRun > maxRun) maxRun = currentRun;
    } else {
      currentRun = 1;
    }
  }
  if (maxRun >= 12) return true;

  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  const maxCount = Math.max(...counts.values());
  const dominance = maxCount / s.length;
  if (s.length >= 20 && dominance >= 0.72) return true;

  const uniqueCount = counts.size;
  if (s.length >= 30 && uniqueCount <= 2) return true;

  return false;
}

function isExcessiveRepeat(words) {
  if (!Array.isArray(words) || words.length === 0) return true;
  const normalized = words.map(w => w.toLowerCase());
  const unique = new Set(normalized);

  if (unique.size === 1 && normalized.length >= 4) return true;
  if (unique.size <= 2 && normalized.length >= 8) return true;

  return false;
}

function normalizeHost(hostname) {
  return (hostname || '').trim().toLowerCase();
}

function hostMatchesRule(host, ruleHost) {
  if (!host || !ruleHost) return false;
  if (host === ruleHost) return true;
  return host.endsWith('.' + ruleHost);
}

function isHostDisabled(settings, hostname) {
  const host = normalizeHost(hostname);
  if (!host) return false;

  const disabled = settings?.disabledSites || {};
  for (const [k, v] of Object.entries(disabled)) {
    if (v === true && hostMatchesRule(host, normalizeHost(k))) return true;
  }

  const overrides = settings?.overrides || {};
  for (const [k, cfg] of Object.entries(overrides)) {
    if (!hostMatchesRule(host, normalizeHost(k))) continue;
    if (cfg && cfg.enabled === false) return true;
  }

  return false;
}

// ---------------- AssemblyAI Non-Streaming ----------------
async function transcribeWithAssemblyAI(audioBlob, language, apiKey, controller) {
  const headers = { Authorization: apiKey };
  const signal = controller?.signal;

  const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers,
    body: audioBlob,
    signal
  });
  if (!uploadResp.ok) {
    const txt = await uploadResp.text().catch(() => '');
    throw new Error(`AssemblyAI upload failed (${uploadResp.status}): ${txt.slice(0, 200)}`);
  }
  const uploadJson = await uploadResp.json();
  const uploadUrl = uploadJson.upload_url;
  if (!uploadUrl) throw new Error('AssemblyAI upload URL missing');

  const transcriptResp = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio_url: uploadUrl,
      language_code: language || undefined,
      punctuate: true,
      format_text: true,
      auto_highlights: false
    }),
    signal
  });
  if (!transcriptResp.ok) {
    const txt = await transcriptResp.text().catch(() => '');
    throw new Error(`AssemblyAI request failed (${transcriptResp.status}): ${txt.slice(0, 200)}`);
  }
  const transcriptJson = await transcriptResp.json();
  const transcriptId = transcriptJson.id;
  if (!transcriptId) throw new Error('AssemblyAI transcript id missing');

  const start = Date.now();
  while (true) {
    if (!disableProcessingTimeouts && Date.now() - start > PROCESSING_TIMEOUT_MS) {
      controller?.abort();
      throw new Error('AssemblyAI timed out');
    }
    await new Promise(r => setTimeout(r, 1000));
    const pollResp = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, { headers, signal });
    if (!pollResp.ok) {
      const txt = await pollResp.text().catch(() => '');
      throw new Error(`AssemblyAI poll failed (${pollResp.status}): ${txt.slice(0, 200)}`);
    }
    const pollJson = await pollResp.json();
    if (pollJson.status === 'completed') return (pollJson.text || '').trim();
    if (pollJson.status === 'error') throw new Error(pollJson.error || 'AssemblyAI transcription error');
  }
}

// ---------------- AssemblyAI Streaming ----------------
function clearAssemblyBeginTimer(session) {
  if (!session?.beginTimer) return;
  try { clearTimeout(session.beginTimer); } catch (_) { }
  session.beginTimer = null;
}

function armAssemblyBeginTimer(session) {
  clearAssemblyBeginTimer(session);
  session.beginTimer = setTimeout(() => {
    if (!session || session.ready) return;
    dbg('assembly_begin_timeout', { tabId: session.tabId, sessionId: session.sessionId });
    try { session.ws?.close(); } catch (_) { }
  }, ASSEMBLYAI_BEGIN_TIMEOUT_MS);
}

function closeAssemblyStreaming(key) {
  const session = assemblyStreamingBySession.get(key);
  if (!session) return;

  clearAssemblyBeginTimer(session);

  try {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ terminate_session: true }));
    }
  } catch (_) { }
  try { session.ws?.close(); } catch (_) { }
  assemblyStreamingBySession.delete(key);
}

async function getAssemblyStreamingToken(apiKey) {
  const params = new URLSearchParams({
    expires_in_seconds: '600'
  });

  const resp = await fetch(`https://streaming.assemblyai.com/v3/token?${params.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: apiKey
    }
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`AssemblyAI token error (${resp.status}): ${txt.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (!data?.token) throw new Error('AssemblyAI token missing in response');
  return data.token;
}

function resolveAssemblyStreamingLanguage(settings) {
  const lang = (settings.language && settings.language !== 'auto')
    ? settings.language
    : null;

  if (!lang) return null;

  if (settings.assemblyaiStreamingMultilingualEnabled === true &&
      !ASSEMBLYAI_MULTILINGUAL_LANGS.has(lang)) {
    return null;
  }

  return lang;
}

function buildAssemblyStreamingUrl(token, opts = {}) {
  const params = new URLSearchParams({
    sample_rate: String(ASSEMBLYAI_STREAM_SAMPLE_RATE),
    encoding: 'pcm_s16le',
    format_turns: 'true',
    token
  });

  const language = (opts.language && opts.language !== 'auto') ? opts.language : null;

  if (opts.multilingual) {
    params.set('speech_model', 'universal-streaming-multilingual');
    params.set('language_detection', language ? 'false' : 'true');
  }

  if (language) {
    params.set('language_code', language);
  }

  return `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`;
}

function openAssemblyStreamingSocket(token, opts = {}) {
  const url = buildAssemblyStreamingUrl(token, opts);
  return new WebSocket(url);
}

function handleStreamingMessage(session, payload) {
  const { tabId, frameId, sessionId, graceEnabled, graceMs } = session;
  const msgType = payload?.type;

  if (msgType === 'Begin') {
    session.ready = true;
    clearAssemblyBeginTimer(session);
    if (session.pendingChunks?.length) {
      for (const chunk of session.pendingChunks) {
        try { session.ws.send(chunk); } catch (_) { }
      }
      session.pendingChunks = [];
    }
    return;
  }

  if (msgType === 'Turn') {
    const text = (payload.transcript || '').trim();
    if (!text) return;

    const isFinal = payload.end_of_turn === true;

    const send = () => {
      sendTerminal(tabId, frameId, {
        type: 'WHISPER_RESULT_TO_PAGE_BRIDGE',
        text,
        sessionId,
        isFinal
      });
    };

    if (isFinal && graceEnabled) setTimeout(send, graceMs);
    else send();

    return;
  }

  if (msgType === 'Termination') {
    const key = sessionKey(tabId, sessionId);
    closeAssemblyStreaming(key);
  }
}

// ---------------- Cancel all sessions ----------------
async function cancelAllSessions(reason = 'config_changed') {
  dbg('cancel_all_sessions', { reason, inflightTabs: inflightByTab.size });

  for (const [tabId, inflight] of inflightByTab.entries()) {
    if (inflight?.sessionId) markCanceled(tabId, inflight.sessionId);

    const key = sessionKey(tabId, inflight.sessionId || 0);
    const controller = assemblyAbortBySession.get(key);
    if (controller) {
      controller.abort();
      assemblyAbortBySession.delete(key);
    }

    inflightByTab.delete(tabId);
    clearProcessingTimeout(tabId);

    try { await clearBadge(tabId); } catch (_) { }
    try { await setTabState(tabId, 'idle', null); } catch (_) { }

    try {
      browser.tabs.sendMessage(tabId, { type: 'WHISPER_CANCEL_ALL', reason }, { frameId: inflight?.frameId });
    } catch (_) { }
  }

  for (const [key] of assemblyStreamingBySession.entries()) {
    closeAssemblyStreaming(key);
  }

  for (const [key] of voskStreamingBySession.entries()) {
    voskStreamingBySession.delete(key);
  }

  for (const tabId of tabStateById.keys()) {
    try { await clearBadge(tabId); } catch (_) { }
    try { await setTabState(tabId, 'idle', null); } catch (_) { }
  }

  canceledSessionsByTab.clear();
  lastSessionByTab.clear();

  await disposeCurrentModel();
  await terminateAsrWorker();
  await terminateVoskWorker();
  trimVoskModelCache({ forceIdle: true });
}

// ---------------- Main message handling ----------------
browser.runtime.onMessage.addListener((message, sender) => {
  
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  if (tabId == null) return;

  // inside browser.runtime.onMessage.addListener(...) near the top
console.log('[Whisper BG] onMessage', message?.type, {
  tabId,
  frameId,
  sessionId: message?.sessionId,
  hostname: message?.hostname
});

  onMessageMaybeResetEpoch(tabId, frameId, message?.pageInstanceId, message?.hostname).catch(() => { });

// ============================================================
// VOSK_STREAM_START handler
// ============================================================
if (message?.type === 'VOSK_STREAM_START') {
  const hostname = message.hostname || '';
  const sessionId = message.sessionId || 0;
  const key = sessionKey(tabId, sessionId);

  console.log('[BG] VOSK_STREAM_START received', { tabId, sessionId, hostname });

  voskPendingChunks.set(key, []);

  const initPromise = (async () => {
    try {
      const settings = await getEffectiveSettings(hostname);
      console.log('[BG] Settings:', { enabled: settings.enabled, provider: settings.provider });
      
      if (!settings.enabled || settings.provider !== PROVIDERS.VOSK) {
        return { ok: false, reason: 'disabled' };
      }

      const modelId = normalizeVoskModel(settings.model);
      const sampleRate = message.sampleRate || 16000;

      const colors = ICON_COLORS();
      showBadgeForTab(tabId, { type: 'download', color: colors.downloading }, BADGE_MS.downloading);

      console.log('[BG] Loading Vosk model directly...', { modelId });
      const res = await ensureVoskModel(modelId);
      console.log('[BG] Model loaded, starting stream...');

      if (res.cached) {
        showBadgeForTab(tabId, { type: 'cached', color: colors.cached }, BADGE_MS.cached);
      } else {
        showBadgeForTab(tabId, { type: 'download', color: colors.downloaded }, BADGE_MS.downloaded);
      }

      startVoskStream(sessionId, tabId, frameId, sampleRate, settings.graceEnabled, settings.graceMs, res.modelId, res.model);
      console.log('[BG] Stream started');

      voskStreamingBySession.set(key, { tabId, frameId, sessionId, hostname });
      voskStreamReady.add(key);

      // Flush buffered chunks
      const pending = voskPendingChunks.get(key) || [];
      console.log('[BG] Flushing buffered chunks:', pending.length);
      
      for (const chunk of pending) {
        sendVoskChunk(sessionId, chunk);
      }
      voskPendingChunks.delete(key);

      return { ok: true };
    } catch (err) {
      console.error('[BG] VOSK init error:', err);
      voskPendingChunks.delete(key);
      voskStreamReady.delete(key);
      showBadgeForTab(tabId, { type: 'download', color: ICON_COLORS().download_error }, BADGE_MS.download_error);
      sendTerminal(tabId, frameId, { type: 'WHISPER_ERROR', error: err?.message || String(err) });
      return { ok: false, error: err?.message };
    }
  })();

  voskStreamInitPromise.set(key, initPromise);
  return;
}

// ============================================================
// VOSK_STREAM_CHUNK handler
// ============================================================
if (message?.type === 'VOSK_STREAM_CHUNK') {
  const sessionId = message.sessionId || 0;
  const key = sessionKey(tabId, sessionId);
  const audioData = message.audioData;
  
  if (!audioData) return;

  if (voskStreamReady.has(key)) {
    // Stream ready, send directly
    sendVoskChunk(sessionId, audioData);
  } else {
    // Still initializing, buffer the chunk
    const pending = voskPendingChunks.get(key);
    if (pending && pending.length < 500) {
      pending.push(audioData);
    }
  }
  return;
}

// ============================================================
// VOSK_STREAM_STOP handler
// ============================================================
if (message?.type === 'VOSK_STREAM_STOP') {
  const sessionId = message.sessionId || 0;
  const key = sessionKey(tabId, sessionId);

  console.log('[BG] VOSK_STREAM_STOP received', { tabId, sessionId });

  (async () => {
    const initPromise = voskStreamInitPromise.get(key);
    
    if (initPromise) {
      console.log('[BG] Waiting for init promise...');
      await initPromise;
      console.log('[BG] Init complete, stopping stream...');
    }

    // Cleanup
    voskStreamInitPromise.delete(key);
    voskPendingChunks.delete(key);
    voskStreamReady.delete(key);
    voskStreamingBySession.delete(key);

    // Stop the recognizer
    stopVoskStream(sessionId);
    console.log('[BG] Stream stopped');
  })();

  return;
}

  if (message?.type === 'ASR_BACKEND_PING') {
    return (async () => {
      try {
        const res = await callAsrWorker('PING', {}, 3000);
        return {
          ok: true,
          backend: res.activeBackend || res.backend || 'unknown',
          preferredBackend: res.preferredBackend || 'unknown',
          hasModelLoaded: !!res.hasModelLoaded,
          webgpu: res.webgpu || null
        };
      } catch (_) {
        return { ok: false, backend: 'unknown', preferredBackend: 'unknown', hasModelLoaded: false, webgpu: null };
      }
    })();
  }

  if (message?.type === 'CONFIG_CHANGED') {
    (async () => {
      let nextFp = null;
      try {
        const { settings } = await browser.storage.local.get('settings');
        const d = settings?.defaults || {};
        nextFp = JSON.stringify({
          provider: d.provider || PROVIDERS.LOCAL,
          model: d.model || 'Xenova/whisper-base',
          voskModel: d.voskModel || DEFAULT_VOSK_MODEL
        });

        if (lastDefaultsFingerprint && nextFp && nextFp !== lastDefaultsFingerprint) {
          await cancelAllSessions('defaults_changed');
        }
        lastDefaultsFingerprint = nextFp;
      } catch (_) { }

      await refreshRuntimeFlagsFromStorage();
      await prefetchDefaultModelIfEnabled();
      await updateDisabledBadgesForAllTabs();
    })();
    return;
  }

  if (message?.type === 'ASSEMBLYAI_STREAM_START') {
    (async () => {
      const hostname = message.hostname || '';
      const sessionId = message.sessionId || 0;
      const key = sessionKey(tabId, sessionId);

      closeAssemblyStreaming(key);

      const settings = await getEffectiveSettings(hostname);
      if (!settings.enabled || settings.provider !== PROVIDERS.ASSEMBLY || !settings.assemblyaiStreamingEnabled) {
        return;
      }

      const rawKey = (settings.assemblyaiApiKey || '').trim();
      if (!rawKey) {
        sendTerminal(tabId, frameId, { type: 'WHISPER_ERROR', error: 'AssemblyAI API key missing. Set it in options.' });
        return;
      }

      let token;
      try {
        token = await getAssemblyStreamingToken(rawKey);
      } catch (err) {
        sendTerminal(tabId, frameId, { type: 'WHISPER_ERROR', error: err?.message || String(err) });
        return;
      }

      const language = resolveAssemblyStreamingLanguage(settings);

      const ws = openAssemblyStreamingSocket(token, {
        multilingual: settings.assemblyaiStreamingMultilingualEnabled === true,
        language
      });

      const session = {
        ws,
        tabId,
        frameId,
        sessionId,
        hostname,
        graceEnabled: settings.graceEnabled,
        graceMs: settings.graceMs,
        ready: false,
        socketOpen: false,
        pendingChunks: []
      };
      assemblyStreamingBySession.set(key, session);

      armAssemblyBeginTimer(session);

      ws.onopen = () => {
        session.socketOpen = true;
        armAssemblyBeginTimer(session);
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data || '{}');
          handleStreamingMessage(session, payload);
        } catch (_) { }
      };

      ws.onerror = () => {
        sendTerminal(tabId, frameId, { type: 'WHISPER_ERROR', error: 'AssemblyAI streaming error' });
        closeAssemblyStreaming(key);
      };

      ws.onclose = (event) => {
        const key = sessionKey(tabId, sessionId);

        if (assemblyStopRequestedBySession.has(key)) {
          assemblyStopRequestedBySession.delete(key);
          closeAssemblyStreaming(key);
          return;
        }

        if (!session.retried) {
          session.retried = true;
          clearAssemblyBeginTimer(session);
          session.pendingChunks = [];
          closeAssemblyStreaming(key);

          (async () => {
            try {
              const freshToken = await getAssemblyStreamingToken(rawKey);
              const retryWs = openAssemblyStreamingSocket(freshToken, {
                multilingual: settings.assemblyaiStreamingMultilingualEnabled === true,
                language
              });

              session.ws = retryWs;
              session.ready = false;
              session.socketOpen = false;

              retryWs.onopen = ws.onopen;
              retryWs.onmessage = ws.onmessage;
              retryWs.onerror = ws.onerror;
              retryWs.onclose = ws.onclose;

              armAssemblyBeginTimer(session);
            } catch (_) {
              closeAssemblyStreaming(key);
            }
          })();

          return;
        }

        if (event?.code === 4001) {
          sendTerminal(tabId, frameId, { type: 'WHISPER_ERROR', error: 'AssemblyAI unauthorized (check API key).' });
        }
        closeAssemblyStreaming(key);
      };
    })();
    return;
  }

  if (message?.type === 'ASSEMBLYAI_STREAM_CHUNK') {
    const sessionId = message.sessionId || 0;
    const key = sessionKey(tabId, sessionId);
    const session = assemblyStreamingBySession.get(key);
    if (!session?.ws) return;

    if (session.ws.readyState === WebSocket.OPEN) {
      try {
        session.ws.send(message.audioData);
      } catch (_) { }
      return;
    }

    session.pendingChunks.push(message.audioData);
    if (session.pendingChunks.length > ASSEMBLYAI_PENDING_CHUNKS_MAX) {
      session.pendingChunks.shift();
    }
    return;
  }

  if (message?.type === 'ASSEMBLYAI_STREAM_STOP') {
    const sessionId = message.sessionId || 0;
    const key = sessionKey(tabId, sessionId);
    assemblyStopRequestedBySession.add(key);
    closeAssemblyStreaming(key);
    return;
  }

  // ---------------- Recording UI state ----------------
  if (message?.type === 'RECORDING_START') {
    const ts = getTabState(tabId);

    if (ts.state !== 'processing') setTabState(tabId, 'recording', null).catch(() => { });

    dbg('recording_start', {
      tabId,
      frameId,
      sessionId: message.sessionId,
      hostname: message.hostname,
      pageInstanceId: message.pageInstanceId
    });
    dbgToTab(tabId, frameId, 'recording_start', {
      tabId,
      frameId,
      sessionId: message.sessionId,
      hostname: message.hostname,
      pageInstanceId: message.pageInstanceId
    });
    return;
  }

  if (message?.type === 'RECORDING_STOP') {
    const ts = getTabState(tabId);
    if (ts.state === 'recording') setTabState(tabId, 'idle', null).catch(() => { });

    dbg('recording_stop', {
      tabId,
      frameId,
      sessionId: message.sessionId,
      hostname: message.hostname,
      canceled: !!message.canceled,
      pageInstanceId: message.pageInstanceId
    });
    dbgToTab(tabId, frameId, 'recording_stop', {
      tabId,
      frameId,
      sessionId: message.sessionId,
      hostname: message.hostname,
      canceled: !!message.canceled,
      pageInstanceId: message.pageInstanceId
    });
    return;
  }

  if (message?.type === 'CANCEL_SESSION') {
    const sessionId = message.sessionId || 0;
    markCanceled(tabId, sessionId);

    const inflight = inflightByTab.get(tabId);
    if (inflight && inflight.sessionId === sessionId) {
      const key = sessionKey(tabId, sessionId);
      const controller = assemblyAbortBySession.get(key);
      if (controller) {
        controller.abort();
        assemblyAbortBySession.delete(key);
      }

      if (inflight.provider === PROVIDERS.LOCAL) {
        terminateAsrWorker().catch(() => { });
        disposeCurrentModel().catch(() => { });
      }

      inflightByTab.delete(tabId);
      clearProcessingTimeout(tabId);
      clearBadge(tabId).catch(() => { });
      setTabState(tabId, 'idle', null).catch(() => { });
    }

    closeAssemblyStreaming(sessionKey(tabId, sessionId));

    const ts = getTabState(tabId);
    ts.errorHoldUntil = 0;
    ts.state = 'idle';

    showBadgeForTab(tabId, { type: 'cancel', color: ICON_COLORS().cancel }, BADGE_MS.cancel);

    dbg('cancel_session', { tabId, frameId, sessionId, pageInstanceId: message.pageInstanceId });
    dbgToTab(tabId, frameId, 'cancel_session', { sessionId, pageInstanceId: message.pageInstanceId });

    scheduleModelGc();
    return;
  }

  if (message?.type !== 'TRANSCRIBE_AUDIO') return;

  const hostname = message.hostname || '';
  const sessionId = message.sessionId || 0;
  const audioBuf = coerceAudioData(message.audioData);

  dbgToTab(tabId, frameId, 'transcribe_request', {
    sessionId,
    hostname,
    pageInstanceId: message.pageInstanceId,
    audioBytes: audioBuf ? audioBuf.byteLength : 0
  });

  if (inflightByTab.has(tabId)) {
    sendTerminal(tabId, frameId, { type: 'WHISPER_ERROR', error: 'Transcription busy - please retry' });
    setTabErrorHold(tabId, 1200).catch(() => { });
    dbgToTab(tabId, frameId, 'busy_reject', { sessionId, pageInstanceId: message.pageInstanceId });
    return;
  }

  const last = lastSessionByTab.get(tabId);
  const lastForHost = (last && last.hostname === hostname) ? last.sessionId : 0;
  if (last && last.hostname !== hostname) lastSessionByTab.set(tabId, { sessionId: 0, hostname });
  if (sessionId <= lastForHost) {
    sendTerminal(tabId, frameId, { type: 'WHISPER_ERROR', error: 'Stale session ignored' });
    setTabErrorHold(tabId, 800).catch(() => { });
    dbgToTab(tabId, frameId, 'stale_reject', { sessionId, lastForHost, pageInstanceId: message.pageInstanceId });
    return;
  }
  lastSessionByTab.set(tabId, { sessionId, hostname });

  if (!audioBuf) {
    sendTerminal(tabId, frameId, { type: 'WHISPER_ERROR', error: 'Invalid audio payload' });
    setTabErrorHold(tabId, ERROR_HOLD_MS).catch(() => { });
    dbgToTab(tabId, frameId, 'invalid_audio', { sessionId, pageInstanceId: message.pageInstanceId });
    return;
  }

  inflightByTab.set(tabId, { sessionId, hostname, frameId });
  setTabState(tabId, 'processing', null).catch(() => { });
  armProcessingTimeout(tabId, sessionId, frameId);

  (async () => {
    try {
      if (isCanceled(tabId, sessionId)) return;

      const settings = await getEffectiveSettings(hostname);
      const { enabled, model, language, graceEnabled, graceMs, provider, assemblyaiApiKey } = settings;

      const inflight = inflightByTab.get(tabId);
      if (inflight) inflight.provider = provider;

      dbgToTab(tabId, frameId, 'effective_settings', { enabled, provider, model, language, graceEnabled, graceMs });

      if (!enabled) {
        sendTerminal(tabId, frameId, { type: 'WHISPER_DISABLED', reason: 'site_disabled' });
        await clearBadge(tabId);
        await setTabState(tabId, 'idle', null);
        return;
      }

      if (provider === PROVIDERS.ASSEMBLY) {
        showBadgeForTab(tabId, { type: 'cloudprocessing', color: ICON_COLORS().cloudprocessing }, BADGE_MS.cloudprocessing);
      }

      const audioBlob = new Blob([new Uint8Array(audioBuf)], { type: 'application/octet-stream' });
      const raw = await readAudio(audioBlob);
      const input = trimSilence(raw);

      if (!input) {
        sendTerminal(tabId, frameId, { type: 'WHISPER_NO_AUDIO', reason: 'silence' });
        await clearBadge(tabId);
        await setTabErrorHold(tabId, 1000);
        dbgToTab(tabId, frameId, 'no_audio', { reason: 'silence' });
        return;
      }

      if (isCanceled(tabId, sessionId)) return;

      let text = '';
      if (provider === PROVIDERS.ASSEMBLY) {
        if (!assemblyaiApiKey) throw new Error('AssemblyAI API key missing. Set it in the options page.');
        const langToUse = (language && language !== 'auto') ? language : null;

        const cancelKey = sessionKey(tabId, sessionId);
        const controller = new AbortController();
        assemblyAbortBySession.set(cancelKey, controller);

        try {
          text = await transcribeWithAssemblyAI(audioBlob, langToUse, assemblyaiApiKey, controller);
        } finally {
          assemblyAbortBySession.delete(cancelKey);
        }
      } else {
        await ensureModelForTab(tabId, model);

        const isEnglishModel = currentModel.endsWith('.en');
        const langToUse = isEnglishModel ? 'en' : (language !== 'auto' ? language : 'auto');

        const res = await callAsrWorker(
          'TRANSCRIBE_FLOAT32',
          { modelID: model, language: langToUse, input },
          PROCESSING_TIMEOUT_MS,
          [input.buffer]
        );

        text = (res.text || '').trim();
        dbgToTab(tabId, frameId, 'local_transcribed', { chars: text.length, model: res.model, cached: !!res.cached, backend: res.backend });
      }

      if (isCanceled(tabId, sessionId)) return;

      await clearBadge(tabId);

      text = collapseRepeats(text);
      const trimmed = text.trim();
      const words = trimmed.split(/\s+/).filter(Boolean);

      if (!trimmed || isPathological(text) || isExcessiveRepeat(words) || isSpammyRepetition(trimmed)) {
        sendTerminal(tabId, frameId, { type: 'WHISPER_NO_AUDIO' });
        sendTerminal(tabId, frameId, { type: 'WHISPER_UNINTELLIGIBLE' });
        await setTabErrorHold(tabId, 2000);
        dbgToTab(tabId, frameId, 'rejected_by_quality_gate', { text });
        return;
      }

      const send = () => {
        if (isCanceled(tabId, sessionId)) return;
        sendTerminal(tabId, frameId, { type: 'WHISPER_RESULT_TO_PAGE_BRIDGE', text, sessionId, isFinal: true });
        dbgToTab(tabId, frameId, 'result_sent', { chars: text.length, sessionId });
      };
      if (graceEnabled) setTimeout(send, graceMs);
      else send();

      await setTabState(tabId, 'idle', null);
      showBadgeForTab(tabId, { type: 'done', color: ICON_COLORS().done }, BADGE_MS.done);
    } catch (err) {
      if (isCanceled(tabId, sessionId)) {
        await clearBadge(tabId);
        await setTabState(tabId, 'idle', null);
        return;
      }
      await clearBadge(tabId);
      sendTerminal(tabId, frameId, { type: 'WHISPER_ERROR', error: err?.message || String(err) });
      await setTabErrorHold(tabId, ERROR_HOLD_MS);
      dbgToTab(tabId, frameId, 'error', { error: err?.message || String(err) });
    } finally {
      const inflight = inflightByTab.get(tabId);
      if (inflight && inflight.sessionId === sessionId) {
        inflightByTab.delete(tabId);
        clearProcessingTimeout(tabId);
      }
      scheduleModelGc();
    }
  })();
});

// Startup hooks
browser.runtime.onStartup?.addListener(() => {
  refreshRuntimeFlagsFromStorage().then(() => prefetchDefaultModelIfEnabled());
});

browser.runtime.onInstalled.addListener((details) => {
  // Always refresh flags first
  refreshRuntimeFlagsFromStorage().then(() => prefetchDefaultModelIfEnabled());

  // Open options on fresh install OR when re-added after removal
  if (details?.reason === 'install' || details?.reason === 'update') {
    // Optional: you could add version comparison if you want to avoid opening on every update
    // e.g. if (!details.previousVersion) { ... } for true first install only
    try {
      browser.runtime.openOptionsPage();
    } catch (err) {
      console.error("Failed to open options page:", err);
    }
  }
});

// ---------------- Tab lifecycle / cleanup ----------------
function clearTabTracking(tabId) {
  inflightByTab.delete(tabId);
  canceledSessionsByTab.delete(tabId);
  lastSessionByTab.delete(tabId);
  clearProcessingTimeout(tabId);
  tabStateById.delete(tabId);

  for (const k of pageInstanceByTabFrame.keys()) {
    if (k.startsWith(`${tabId}:`)) pageInstanceByTabFrame.delete(k);
  }

  for (const [key, session] of assemblyStreamingBySession.entries()) {
    if (session.tabId === tabId) {
      closeAssemblyStreaming(key);
    }
  }

  for (const [key, session] of voskStreamingBySession.entries()) {
    if (session.tabId === tabId) {
      voskStreamingBySession.delete(key);
    }
  }
}

browser.tabs.onCreated.addListener((tab) => {
  if (tab?.id == null) return;
  ensureTabIconInitialized(tab.id).catch(() => { });
});

browser.tabs.onActivated.addListener(({ tabId }) => {
  ensureTabIconInitialized(tabId).catch(() => { });
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
    ensureTabIconInitialized(tabId).catch(() => { });
  }
  if (changeInfo.discarded === true || changeInfo.status === 'unloaded') {
    clearTabTracking(tabId);
    scheduleModelGc();
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  clearTabTracking(tabId);
  scheduleModelGc();
});

// In tabs.onUpdated (when URL changes)
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
    ensureTabIconInitialized(tabId).catch(() => { });
    updateDisabledBadgesForAllTabs().catch(() => { });
  }
  if (changeInfo.discarded === true || changeInfo.status === 'unloaded') {
    clearTabTracking(tabId);
    scheduleModelGc();
  }
});

// Init existing tabs + load flags + maybe prefetch
(async () => {
  try {
    await refreshRuntimeFlagsFromStorage();
    await prefetchDefaultModelIfEnabled();
    await updateDisabledBadgesForAllTabs();
  } catch (_) { }
  try {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (tab?.id == null) continue;
      await ensureTabIconInitialized(tab.id);
    }
  } catch (_) { }
})();