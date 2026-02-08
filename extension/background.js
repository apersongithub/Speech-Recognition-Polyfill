// background.js (MV2) - Firefox
// Worker-based local Whisper to allow freeing WASM memory by terminating the worker.
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
  ASSEMBLY: 'assemblyai'
};

// Default model: base multilingual
let currentModel = 'Xenova/whisper-base';

// used only to serialize ENSURE_MODEL + show badges
let modelLoadPromise = null;

// Cache-default-model residency control:
let keepModelResident = false;
let residentModelId = null;

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

const RESULT_GRACE_MS_DEFAULT = 450;

const PROCESSING_TIMEOUT_MS = 20000;
const ERROR_HOLD_MS = 2500;

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
  // Normalize missing frameId to 0 (top frame) so keys are stable.
  const fid = (typeof frameId === 'number') ? frameId : 0;
  return `${tabId}:${fid}`;
}

async function onMessageMaybeResetEpoch(tabId, frameId, pageInstanceId, hostname) {
  if (tabId == null) return;

  const key = tabFrameKey(tabId, frameId);
  if (!pageInstanceId) {
    // If page doesn't send it (older content.js), do nothing.
    return;
  }

  const prev = pageInstanceByTabFrame.get(key);
  if (prev && prev !== pageInstanceId) {
    // Content script instance changed (reload/navigation). Reset per-tab ordering state.
    dbg('page_instance_changed_reset', { tabId, frameId, hostname, prev, next: pageInstanceId });

    // Reset monotonic session tracking for this tab.
    lastSessionByTab.delete(tabId);

    // Cancel inflight work for this tab (best-effort).
    const inflight = inflightByTab.get(tabId);
    if (inflight?.sessionId) markCanceled(tabId, inflight.sessionId);
    inflightByTab.delete(tabId);
    clearProcessingTimeout(tabId);

    try { await clearBadge(tabId); } catch (_) { }
    try { await setTabState(tabId, 'idle', null); } catch (_) { }
  }

  pageInstanceByTabFrame.set(key, pageInstanceId);
}

// ---------------- ASR Worker (WASM isolation) ----------------
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

// ---------------- Runtime flags ----------------
async function refreshRuntimeFlagsFromStorage() {
  try {
    const { settings } = await browser.storage.local.get('settings');
    debugMode = settings?.debugMode === true;

    const cacheDefaultModel = settings?.cacheDefaultModel === true;
    const defaults = settings?.defaults || {};
    const provider = (defaults.provider === PROVIDERS.ASSEMBLY) ? PROVIDERS.ASSEMBLY : PROVIDERS.LOCAL;

    const model = (defaults.model && ALLOWED_MODELS.has(defaults.model))
      ? defaults.model
      : 'Xenova/whisper-base';

    keepModelResident = !!(cacheDefaultModel && provider === PROVIDERS.LOCAL && ALLOWED_MODELS.has(model));
    residentModelId = keepModelResident ? model : null;

    dbg('runtime_flags', { debugMode, keepModelResident, residentModelId, provider, model });
  } catch (_) {
    debugMode = false;
    keepModelResident = false;
    residentModelId = null;
  }

  if (!keepModelResident) scheduleModelGc();
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
    // Only show when idle so we don't override recording/processing states.
    if (ts.state !== 'idle') return;
    showBadgeForTab(
      tabId,
      { type: 'disabled', color: ICON_COLORS().disabled },
      0 // persistent
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
  if (ts.errorHoldUntil > now && effectiveState !== 'error') effectiveState = 'error';

  const color = computeColor(effectiveState);
  const title = computeTitle(effectiveState);

  const images = await getIconImageData(color, ts.badge);
  await browser.browserAction.setIcon({ tabId, imageData: images });
  await browser.browserAction.setTitle({ tabId, title });
}

async function setTabState(tabId, state, badge = null) {
  const ts = getTabState(tabId);
  const now = Date.now();
  if (ts.errorHoldUntil > now && state !== 'error') return;

  ts.state = state;
  ts.badge = badge;
  await applyIconForTab(tabId);
}

async function clearBadge(tabId) {
  const ts = tabStateById.get(tabId);
  if (!ts) return;
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
  if (ms > 0) {
    setTimeout(() => {
      const t2 = tabStateById.get(tabId);
      if (!t2) return;
      if (t2.badge && t2.badge.type === badge.type) {
        t2.badge = null;
        applyIconForTab(tabId).catch(() => { });
      }
    }, ms);
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
  try { browser.tabs.sendMessage(tabId, payload, { frameId }); } catch (_) { }
}

// ---------- Model / GC / Prefetch (worker-based) ----------
async function disposeCurrentModel() {
  if (!asrWorker) return;
  try { await callAsrWorker('DISPOSE_MODEL', {}, 10_000); } catch (_) { }
}

function scheduleModelGc() {
  if (keepModelResident && residentModelId) {
    if (modelGcTimer) { clearTimeout(modelGcTimer); modelGcTimer = null; }
    dbg('gc_skip_resident_default', { residentModelId });
    return;
  }

  if (modelGcTimer) clearTimeout(modelGcTimer);
  modelGcTimer = setTimeout(async () => {
    if (inflightByTab.size > 0) return;
    if (modelLoadPromise) return;
    if (keepModelResident && residentModelId) return;

    await disposeCurrentModel();
    await terminateAsrWorker();
    dbg('worker_terminated_idle', { afterMs: MODEL_IDLE_UNLOAD_MS });
  }, MODEL_IDLE_UNLOAD_MS);
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
  } catch (e) {
    showBadgeForTab(tabId, { type: 'download', color: colors.download_error }, BADGE_MS.download_error);
    throw e;
  } finally {
    modelLoadPromise = null;
  }
}

async function prefetchDefaultModelIfEnabled() {
  if (!keepModelResident || !residentModelId) return;

  try {
    dbg('prefetch_start', { model: residentModelId });
    await ensureModelSilently(residentModelId);
    dbg('prefetch_done', { model: residentModelId });
  } catch (e) {
    dbg('prefetch_failed', { error: String(e) });
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
  if (collapsed.length > 400) collapsed = collapsed.slice(0, 400) + '…';
  return collapsed.trim();
}

// ---------------- quality guard helpers ----------------
function isPathological(text) {
  if (!text) return true;
  const tokens = text.split(/\s+/);
  const unique = new Set(tokens);
  return (text.length > 80 && unique.size <= 3) || tokens.length === 0;
}

// NEW: robust spam detector (run-length + dominance + entropy)
function isSpammyRepetition(text) {
  if (!text) return true;
  const s = text.trim();
  if (s.length < 8) return false;

  // 1) Run-length (e.g., "FFFFFFFFFFFF")
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

  // 2) Dominance ratio (one char dominates the string)
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  const maxCount = Math.max(...counts.values());
  const dominance = maxCount / s.length;
  if (s.length >= 20 && dominance >= 0.72) return true;

  // 3) Low entropy (very low diversity at longer lengths)
  const uniqueCount = counts.size;
  if (s.length >= 30 && uniqueCount <= 2) return true;

  return false;
}

function isExcessiveRepeat(words) {
  if (!Array.isArray(words) || words.length === 0) return true;
  const normalized = words.map(w => w.toLowerCase());
  const unique = new Set(normalized);

  // Same word repeated 4+ times is likely a glitch
  if (unique.size === 1 && normalized.length >= 4) return true;

  // Two-word loop repeated many times can also be a glitch
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

async function getEffectiveSettings(hostname) {
  const { settings } = await browser.storage.local.get('settings');
  const defaults = settings?.defaults || { model: 'Xenova/whisper-base', language: 'auto', provider: PROVIDERS.LOCAL };
  const graceEnabled = settings?.graceEnabled !== false;
  const graceMs = typeof settings?.graceMs === 'number' ? settings.graceMs : RESULT_GRACE_MS_DEFAULT;
  const assemblyaiApiKey = settings?.assemblyaiApiKey || null;

  const baseProvider = (defaults.provider === PROVIDERS.ASSEMBLY) ? PROVIDERS.ASSEMBLY : PROVIDERS.LOCAL;
  const overrides = settings?.overrides || {};
  const host = normalizeHost(hostname);
  const site = host ? (overrides[host] || {}) : {};
  const provider = (site.provider ?? baseProvider) === PROVIDERS.ASSEMBLY ? PROVIDERS.ASSEMBLY : PROVIDERS.LOCAL;

  const disabled = isHostDisabled(settings, host);

  return {
    enabled: !disabled,
    model: (site.model && ALLOWED_MODELS.has(site.model))
      ? site.model
      : (ALLOWED_MODELS.has(defaults.model) ? defaults.model : 'Xenova/whisper-base'),
    language: site.language ?? defaults.language ?? 'auto',
    graceEnabled,
    graceMs,
    provider,
    assemblyaiApiKey
  };
}

async function transcribeWithAssemblyAI(audioBlob, language, apiKey) {
  const headers = { Authorization: apiKey };
  const controller = new AbortController();

  const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers,
    body: audioBlob,
    signal: controller.signal
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
    signal: controller.signal
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
    if (Date.now() - start > PROCESSING_TIMEOUT_MS) {
      controller.abort();
      throw new Error('AssemblyAI timed out');
    }
    await new Promise(r => setTimeout(r, 1000));
    const pollResp = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, { headers, signal: controller.signal });
    if (!pollResp.ok) {
      const txt = await pollResp.text().catch(() => '');
      throw new Error(`AssemblyAI poll failed (${pollResp.status}): ${txt.slice(0, 200)}`);
    }
    const pollJson = await pollResp.json();
    if (pollJson.status === 'completed') return (pollJson.text || '').trim();
    if (pollJson.status === 'error') throw new Error(pollJson.error || 'AssemblyAI transcription error');
  }
}

// ---------------- Cancel all sessions (used on model change / config change) ----------------
async function cancelAllSessions(reason = 'config_changed') {
  dbg('cancel_all_sessions', { reason, inflightTabs: inflightByTab.size });

  for (const [tabId, inflight] of inflightByTab.entries()) {
    if (inflight?.sessionId) markCanceled(tabId, inflight.sessionId);

    inflightByTab.delete(tabId);
    clearProcessingTimeout(tabId);

    try { await clearBadge(tabId); } catch (_) { }
    try { await setTabState(tabId, 'idle', null); } catch (_) { }

    try {
      browser.tabs.sendMessage(tabId, { type: 'WHISPER_CANCEL_ALL', reason }, { frameId: inflight?.frameId });
    } catch (_) { }
  }

  for (const tabId of tabStateById.keys()) {
    try { await clearBadge(tabId); } catch (_) { }
    try { await setTabState(tabId, 'idle', null); } catch (_) { }
  }

  canceledSessionsByTab.clear();
  lastSessionByTab.clear();

  await disposeCurrentModel();
  await terminateAsrWorker();
}

// ---------------- Main message handling ----------------
browser.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  if (tabId == null) return;

  ensureTabIconInitialized(tabId).catch(() => { });

  // NEW: reset epoch/order state if this is a new content-script instance.
  // Fire-and-forget; we don't await because onMessage can't be async here.
  onMessageMaybeResetEpoch(tabId, frameId, message?.pageInstanceId, message?.hostname).catch(() => { });

  if (message?.type === 'CONFIG_CHANGED') {
    (async () => {
      let nextFp = null;
      try {
        const { settings } = await browser.storage.local.get('settings');
        const d = settings?.defaults || {};
        nextFp = JSON.stringify({
          provider: d.provider || PROVIDERS.LOCAL,
          model: d.model || 'Xenova/whisper-base'
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

  if (message?.type === 'RECORDING_START') {
    const ts = getTabState(tabId);
    if (ts.state !== 'processing') setTabState(tabId, 'recording', null).catch(() => { });
    dbgToTab(tabId, frameId, 'recording_start', { sessionId: message.sessionId, hostname: message.hostname, pageInstanceId: message.pageInstanceId });
    return;
  }

  if (message?.type === 'RECORDING_STOP') {
    const ts = getTabState(tabId);
    if (ts.state === 'recording') setTabState(tabId, 'idle', null).catch(() => { });
    dbgToTab(tabId, frameId, 'recording_stop', { sessionId: message.sessionId, canceled: !!message.canceled, pageInstanceId: message.pageInstanceId });
    return;
  }

  if (message?.type === 'CANCEL_SESSION') {
    const sessionId = message.sessionId || 0;
    markCanceled(tabId, sessionId);

    const inflight = inflightByTab.get(tabId);
    if (inflight && inflight.sessionId === sessionId) {
      inflightByTab.delete(tabId);
      clearProcessingTimeout(tabId);
      clearBadge(tabId).catch(() => { });
      setTabState(tabId, 'idle', null).catch(() => { });
    }

    showBadgeForTab(tabId, { type: 'cancel', color: ICON_COLORS().cancel }, BADGE_MS.cancel);
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
        text = await transcribeWithAssemblyAI(audioBlob, langToUse, assemblyaiApiKey);
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
        dbgToTab(tabId, frameId, 'local_transcribed', { chars: text.length, model: res.model, cached: !!res.cached });
      }

      if (isCanceled(tabId, sessionId)) return;

      await clearBadge(tabId);

      // ... inside the transcription completion section ...
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
        sendTerminal(tabId, frameId, { type: 'WHISPER_RESULT_TO_PAGE_BRIDGE', text });
        dbgToTab(tabId, frameId, 'result_sent', { chars: text.length });
      };
      if (graceEnabled) setTimeout(send, graceMs);
      else send();

      await setTabState(tabId, 'idle', null);
      showBadgeForTab(tabId, { type: 'done', color: ICON_COLORS().done }, BADGE_MS.done);
    } catch (err) {
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
  refreshRuntimeFlagsFromStorage().then(() => prefetchDefaultModelIfEnabled());

  if (details?.reason === 'install') {
    try { browser.runtime.openOptionsPage(); } catch (_) {}
  }
});


// ---------------- Tab lifecycle / cleanup ----------------
function clearTabTracking(tabId) {
  inflightByTab.delete(tabId);
  canceledSessionsByTab.delete(tabId);
  lastSessionByTab.delete(tabId);
  clearProcessingTimeout(tabId);
  tabStateById.delete(tabId);

  // NEW: drop any epoch mapping for this tab (all frames)
  for (const k of pageInstanceByTabFrame.keys()) {
    if (k.startsWith(`${tabId}:`)) pageInstanceByTabFrame.delete(k);
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