// background.js (MV2) - VAD, dynamic icon colors, dark-mode awareness, ack-based icon state,
// i18n titles + corner badges for download/cache/done/cancel + cancel-safe sessions with grace window (toggleable)

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.16.1';

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

let transcriber = null;
let currentModel = 'Xenova/whisper-tiny';
let currentBackend = 'wasm';
const inflightByTab = new Map();
const lastSessionByTab = new Map(); // tabId -> { sessionId, hostname }
const canceledSessionsByTab = new Map(); // tabId -> Set(sessionId)
const activeRecognitionTabs = new Set(); // tabs that have fired recording/transcribe
let modelLoadPromise = null;

const RESULT_GRACE_MS_DEFAULT = 450; // default grace window
const CANCEL_BADGE_MS = 1200;        // cancel badge display
const PROCESSING_TIMEOUT_MS = 12000; // tighter timeout to avoid long hangs

const MODEL_IDLE_UNLOAD_MS = 15_000; // unload model after 15s of idle
let modelGcTimer = null;
let errorHoldUntil = 0;

// Track extension pages so we don't self-reload while they're open
const extensionTabIds = new Set();
let reloadPending = false;

const isDarkMode = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => setActionState(currentState, currentBadge));

const ICON_COLORS = () => ({
    idle: isDarkMode() ? '#e5e7eb' : '#374151',
    recording: '#2563eb',
    processing: '#f59e0b',
    error: '#dc2626',
    downloading: '#3b82f6',
    downloaded: '#16a34a',
    download_error: '#dc2626',
    cached: '#0ea5e9',
    done: '#16a34a',
    cancel: '#ef4444'
});

let currentState = 'idle';
let currentBadge = null; // { type: 'download' | 'cached' | 'done' | 'cancel', color }
const iconCache = new Map(); // key -> {16,19,32,38}
const processingFallback = { timer: null, tabId: null };
let errorResetTimer = null;

// Debug logging (enabled when settings.debugMode === true)
let debugMode = false;
const DEBUG_BUFFER_LIMIT = 400;
const debugBuffer = [];
function dbg(tag, data = {}) {
    if (!debugMode) return;
    const entry = { ts: new Date().toISOString(), tag, ...data };
    debugBuffer.push(entry);
    if (debugBuffer.length > DEBUG_BUFFER_LIMIT) debugBuffer.shift();
    try { console.debug('[Whisper DEBUG]', tag, data); } catch (_) { /* swallow */ }
}
async function refreshDebugModeFromStorage() {
    try {
        const { settings } = await browser.storage.local.get('settings');
        const next = settings?.debugMode === true;
        if (next !== debugMode) dbg('debug_mode_toggle', { from: debugMode, to: next });
        debugMode = next;
    } catch (_) { /* swallow */ }
}
refreshDebugModeFromStorage();

// -------- Options tab auto-unload (discard/close after inactivity) --------
const OPTIONS_UNLOAD_MS = 10_000; // 10s before unloading inactive options tab
const optionsUnloadTimers = new Map();

const isOptionsUrl = (url) => {
    if (!url) return false;
    const base = browser.runtime.getURL('options.html');
    return url === base || url.startsWith(base + '#') || url.startsWith(base + '?');
};

function clearOptionsUnloadTimer(tabId) {
    const t = optionsUnloadTimers.get(tabId);
    if (t) {
        clearTimeout(t);
        optionsUnloadTimers.delete(tabId);
    }
}

function scheduleOptionsUnload(tabId) {
    clearOptionsUnloadTimer(tabId);
    const timer = setTimeout(async () => {
        optionsUnloadTimers.delete(tabId);
        try {
            if (browser.tabs.discard) {
                await browser.tabs.discard(tabId); // unload but keep tab open
            } else {
                await browser.tabs.remove(tabId);   // fallback: close tab
            }
            extensionTabIds.delete(tabId);
        } catch (_) {
            /* swallow */
        }
    }, OPTIONS_UNLOAD_MS);
    optionsUnloadTimers.set(tabId, timer);
}

async function refreshOptionsUnloadTimers() {
    try {
        const optionsTabs = await browser.tabs.query({ url: browser.runtime.getURL('options.html') });
        for (const tab of optionsTabs) {
            if (tab.active) {
                clearOptionsUnloadTimer(tab.id);
            } else {
                scheduleOptionsUnload(tab.id);
            }
        }
    } catch (_) {
        /* swallow */
    }
}
// ------------------------------------------------------------------------

function isExtensionUrl(url) {
    if (!url) return false;
    const base = browser.runtime.getURL('');
    return url.startsWith(base);
}

// Populate extensionTabIds on startup (best-effort)
browser.tabs.query({}).then(tabs => {
    tabs.forEach(t => { if (isExtensionUrl(t.url)) extensionTabIds.add(t.id); });
}).catch(() => {});

// Track extension tabs and handle unload/discard
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && isExtensionUrl(changeInfo.url)) {
        extensionTabIds.add(tabId);
    } else if (changeInfo.url && !isExtensionUrl(changeInfo.url)) {
        extensionTabIds.delete(tabId);
    }

    // Options tab unload logic
    if (changeInfo.url) {
        if (!isOptionsUrl(changeInfo.url)) {
            clearOptionsUnloadTimer(tabId);
            extensionTabIds.delete(tabId);
        }
    }
    if (isOptionsUrl(tab?.url)) {
        refreshOptionsUnloadTimers();
    }

    if (changeInfo.discarded === true || changeInfo.status === 'unloaded') {
        clearTabTracking(tabId);
        extensionTabIds.delete(tabId);
        clearOptionsUnloadTimer(tabId);
        if (!isBusy() && activeRecognitionTabs.size === 0) {
            scheduleModelGc();
        }
    }

    // If no extension tabs remain and a reload was pending, trigger it when idle
    if (extensionTabIds.size === 0 && reloadPending && !isBusy() && activeRecognitionTabs.size === 0) {
        reloadPending = false;
        browser.runtime.reload();
    }
});

// New: options tab tracking on create/activate
browser.tabs.onCreated.addListener((tab) => {
    if (isOptionsUrl(tab.url) && !tab.active) {
        scheduleOptionsUnload(tab.id);
    }
});
browser.tabs.onActivated.addListener(() => {
    refreshOptionsUnloadTimers();
});

function t(key, fallback) {
    return (browser.i18n && browser.i18n.getMessage(key)) || fallback;
}

function colorizeSvg(svgText, color) {
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
    return colorizeSvg(raw, color);
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
    if (iconCache.has(cacheKey)) return iconCache.get(cacheKey);

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
        let badgePath = 'images/downmodel.svg';
        if (badge.type === 'cached') badgePath = 'images/cached.svg';
        else if (badge.type === 'done') badgePath = 'images/check.svg';
        else if (badge.type === 'cancel') badgePath = 'images/cancel.svg';
        const badgeSvg = await fetchSvg(badgePath, badge.color);
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
            const y = size - badgeSize - padding; // bottom-right

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
    iconCache.set(cacheKey, out);
    return out;
}

// setActionState honors error hold so error stays visible
async function setActionState(state, badge = null) {
    const now = Date.now();
    if (errorHoldUntil > now && state !== 'error') {
        return;
    }

    const prev = currentState;
    currentState = state;
    currentBadge = badge;
    const colors = ICON_COLORS();
    let color = colors.idle;
    let title = t('title_idle', 'Whisper: Idle');
    if (state === 'recording') { color = colors.recording; title = t('title_recording', 'Whisper: Listening'); }
    else if (state === 'processing') { color = colors.processing; title = t('title_processing', 'Whisper: Processing'); }
    else if (state === 'error') { color = colors.error; title = t('title_error', 'Whisper: Error'); }

    dbg('action_state', { from: prev, to: state, badge, errorHoldUntil });

    try {
        const images = await getIconImageData(color, badge);
        await browser.browserAction.setIcon({ imageData: images });
    } catch (e) { console.warn('Failed to set icon', e); }
    try { await browser.browserAction.setTitle({ title }); } catch (e) { }
}

// Make error stick briefly
function setErrorBriefly(ms = 3000) {
    errorHoldUntil = Date.now() + ms;
    if (errorResetTimer) clearTimeout(errorResetTimer);
    setActionState('error', null);
    errorResetTimer = setTimeout(() => {
        errorResetTimer = null;
        errorHoldUntil = 0;
        setActionState('idle', null);
    }, ms);
}

// cancel tracking
function markCanceled(tabId, sessionId) {
    if (!tabId || !sessionId) return;
    let set = canceledSessionsByTab.get(tabId);
    if (!set) { set = new Set(); canceledSessionsByTab.set(tabId, set); }
    set.add(sessionId);
    dbg('session_canceled', { tabId, sessionId, canceledForTab: set.size });
}
function isCanceled(tabId, sessionId) {
    const set = canceledSessionsByTab.get(tabId);
    return !!(set && set.has(sessionId));
}

// Collapse pathological repeats
function collapseRepeats(text) {
    const words = text.trim().split(/\s+/);
    const out = [];
    let last = null, run = 0;

    for (const w of words) {
        if (w === last) {
            run += 1;
            if (run <= 3) out.push(w);
        } else {
            last = w; run = 1;
            out.push(w);
        }
    }
    let collapsed = out.join(' ');
    collapsed = collapsed.replace(/(\b[\w\.\-]{1,8}\b)(\s+\1){4,}/gi, '$1 $1 $1');
    const MAX_LEN = 400;
    if (collapsed.length > MAX_LEN) collapsed = collapsed.slice(0, MAX_LEN) + '…';
    return collapsed.trim();
}

function isPathological(text) {
    if (!text) return true;
    const tokens = text.split(/\s+/);
    const unique = new Set(tokens);
    return (text.length > 80 && unique.size <= 3) || tokens.length === 0;
}

// grace sender with toggle
function sendResultWithGrace(tabId, sessionId, text, options, graceEnabled, graceMs) {
    const send = () => {
        if (isCanceled(tabId, sessionId)) return;
        browser.tabs.sendMessage(tabId, { type: 'WHISPER_RESULT_TO_PAGE_BRIDGE', text }, options);
    };
    if (!graceEnabled) {
        send();
        return;
    }
    setTimeout(send, graceMs);
}

// Model disposal helpers
async function disposeCurrentModel() {
    if (transcriber?.dispose) {
        try { await transcriber.dispose(); } catch (e) { console.warn('dispose failed', e); }
    }
    transcriber = null;
    dbg('model_disposed', { model: currentModel });
}

// Busy guard
function isBusy() {
    const hasInflight = inflightByTab.size > 0;
    const processing = processingFallback.timer !== null;
    return hasInflight || processing || currentState === 'recording' || currentState === 'processing';
}

// Schedule GC: only when idle AND no tabs that used recognition remain
function scheduleModelGc() {
    if (modelGcTimer) clearTimeout(modelGcTimer);
    modelGcTimer = setTimeout(async () => {
        const busy = isBusy();
        if (busy) { dbg('gc_skip_busy'); return; }
        if (activeRecognitionTabs.size > 0) { dbg('gc_skip_active_tabs', { count: activeRecognitionTabs.size }); return; }
        dbg('gc_run', { model: currentModel, extensionTabs: extensionTabIds.size });
        await disposeCurrentModel();
        setActionState('idle', null);
        if (extensionTabIds.size === 0) {
            reloadPending = false;
            browser.runtime.reload();
        } else {
            reloadPending = true;
        }
    }, MODEL_IDLE_UNLOAD_MS);
}

// Prefetch default model when enabled and provider is local
async function prefetchDefaultModelIfEnabled() {
    try {
        const { settings } = await browser.storage.local.get('settings');
        const defaults = settings?.defaults || {};
        const cacheDefaultModel = settings?.cacheDefaultModel === true;
        const provider = (defaults.provider === PROVIDERS.ASSEMBLY) ? PROVIDERS.ASSEMBLY : PROVIDERS.LOCAL;
        const model = defaults.model || 'Xenova/whisper-tiny';
        if (!cacheDefaultModel) return;
        if (provider !== PROVIDERS.LOCAL) return;
        if (!ALLOWED_MODELS.has(model)) return;
        dbg('prefetch_start', { model });
        await ensureModel(model);
        dbg('prefetch_done', { model });
    } catch (e) {
        console.warn('Prefetch default model failed', e);
        dbg('prefetch_error', { error: String(e) });
    }
}

// Immediately set icon state on background load to avoid black icon after self-reload
setActionState('idle', null);
// Kick off options tab unload tracking on startup
refreshOptionsUnloadTimers();
// Prefetch on startup if enabled
prefetchDefaultModelIfEnabled();

browser.runtime.onInstalled.addListener(async (details) => {
    if (details?.reason === 'install') {
        // Always open options in a new tab for first-time users
        try {
            await browser.tabs.create({ url: browser.runtime.getURL('options.html'), active: true });
        } catch {
            try { await browser.runtime.openOptionsPage(); } catch (_) { }
        }
    }
    setActionState('idle', null);
});
browser.runtime.onStartup?.addListener(() => {
    setActionState('idle', null);
    prefetchDefaultModelIfEnabled();
});

function clearTabTracking(tabId) {
    inflightByTab.delete(tabId);
    lastSessionByTab.delete(tabId);
    canceledSessionsByTab.delete(tabId);
    activeRecognitionTabs.delete(tabId);
}

browser.runtime.onMessage.addListener((message, sender) => {
    const tabId = sender?.tab?.id;

    if (message?.type === 'CONFIG_CHANGED') {
        refreshDebugModeFromStorage();
        prefetchDefaultModelIfEnabled();
        return;
    }

    if (message?.type === 'GET_DEBUG_BUFFER') {
        return Promise.resolve(debugBuffer.slice(-DEBUG_BUFFER_LIMIT));
    }

    if (message?.type === 'CANCEL_SESSION') {
        markCanceled(tabId, message.sessionId);
        inflightByTab.delete(tabId);
        if (processingFallback.timer) { clearTimeout(processingFallback.timer); processingFallback.timer = null; }
        processingFallback.tabId = null;
        setActionState('idle', { type: 'cancel', color: ICON_COLORS().cancel });
        setTimeout(() => {
            if (currentState === 'idle' && currentBadge?.type === 'cancel') {
                setActionState('idle', null);
            }
        }, CANCEL_BADGE_MS);
        scheduleModelGc();
        return;
    }

    if (message?.type === 'PROCESSING_DONE') {
        if (processingFallback.timer) { clearTimeout(processingFallback.timer); processingFallback.timer = null; }
        processingFallback.tabId = null;
        if (tabId != null) activeRecognitionTabs.delete(tabId);

        dbg('processing_done', { status: message.status, tabId });

        if (message.status === 'noaudio') {
            setActionState('error', null);
            setTimeout(() => {
                if (currentState === 'error') setActionState('idle', null);
            }, 800);
            scheduleModelGc();
            return;
        }
        if (message.status === 'error') {
            setActionState('error', null);
            scheduleModelGc();
            return;
        }

        setActionState('idle', { type: 'done', color: ICON_COLORS().done });
        setTimeout(() => {
            if (currentState === 'idle' && currentBadge?.type === 'done') {
                setActionState('idle', null);
            }
            scheduleModelGc();
        }, 600);
        return;
    }

    if (message?.type === 'UNINTELLIGIBLE_SPEECH') {
        if (processingFallback.timer) { clearTimeout(processingFallback.timer); processingFallback.timer = null; }
        processingFallback.tabId = null;
        if (tabId != null) activeRecognitionTabs.delete(tabId);
        dbg('unintelligible_speech', { tabId });
        setErrorBriefly(3500); // show error and hold it
        scheduleModelGc();
        return;
    }

    if (message?.type === 'RECORDING_STATE') {
        if (tabId != null) {
            if (message.state === 'recording') activeRecognitionTabs.add(tabId);
            else activeRecognitionTabs.delete(tabId);
        }
        dbg('recording_state', { tabId, state: message.state, activeRecognitionTabs: activeRecognitionTabs.size });
        setActionState(message.state === 'recording' ? 'recording' : 'idle', null);
        return;
    }
});

function trimSilence(audioData, sampleRate = 16000) {
    const threshold = 0.01; // a bit more tolerant to low-level noise
    let start = 0, end = audioData.length;
    for (let i = 0; i < audioData.length; i++) { if (Math.abs(audioData[i]) > threshold) { start = i; break; } }
    for (let i = audioData.length - 1; i >= start; i--) { if (Math.abs(audioData[i]) > threshold) { end = i + 1; break; } }
    const trimmed = audioData.subarray(start, end);
    if (trimmed.length < sampleRate * 0.2) return null;
    return trimmed;
}

function normalizeProvider(p) {
    return (p === PROVIDERS.ASSEMBLY) ? PROVIDERS.ASSEMBLY : PROVIDERS.LOCAL;
}

async function getEffectiveSettings(hostname) {
    const { settings } = await browser.storage.local.get('settings');
    const defaults = settings?.defaults || { model: 'Xenova/whisper-tiny', language: 'auto', silenceTimeoutMs: 1500, provider: PROVIDERS.LOCAL };
    const graceEnabled = settings?.graceEnabled !== false; // default true
    const graceMs = typeof settings?.graceMs === 'number' ? settings.graceMs : RESULT_GRACE_MS_DEFAULT;
    const assemblyaiApiKey = settings?.assemblyaiApiKey || null;

    const baseProvider = normalizeProvider(defaults.provider);
    if (!hostname) return { model: defaults.model, language: defaults.language, silenceTimeoutMs: defaults.silenceTimeoutMs, graceEnabled, graceMs, provider: baseProvider, assemblyaiApiKey };

    const overrides = settings?.overrides || {};
    const site = overrides[hostname] || {};
    const result = {
        model: (site.model && ALLOWED_MODELS.has(site.model)) ? site.model : (ALLOWED_MODELS.has(defaults.model) ? defaults.model : 'Xenova/whisper-tiny'),
        language: site.language ?? defaults.language ?? 'auto',
        silenceTimeoutMs: site.silenceTimeoutMs ?? defaults.silenceTimeoutMs ?? 1500,
        graceEnabled,
        graceMs,
        provider: normalizeProvider(site.provider ?? baseProvider),
        assemblyaiApiKey
    };
    dbg('effective_settings', { hostname, ...result });
    return result;
}

async function loadModel(modelID) {
    dbg('model_load_start', { modelID });
    transcriber = await pipeline('automatic-speech-recognition', modelID, { device: currentBackend });
    currentModel = modelID;
    dbg('model_load_success', { modelID });
}

async function showCachedBadge(prevState) {
    setActionState(prevState, { type: 'cached', color: ICON_COLORS().cached });
    setTimeout(() => {
        if (currentState === prevState && currentBadge?.type === 'cached') {
            setActionState(prevState, null);
        }
    }, 1000);
}

async function ensureModel(modelID) {
    const safeModel = ALLOWED_MODELS.has(modelID) ? modelID : 'Xenova/whisper-tiny';
    const prevState = currentState;

    if (transcriber && currentModel === safeModel) {
        await showCachedBadge(prevState);
        dbg('model_reuse', { model: safeModel });
        return;
    }

    if (transcriber && currentModel !== safeModel) {
        dbg('model_dispose_switch', { from: currentModel, to: safeModel });
        await disposeCurrentModel();
    }

    if (modelLoadPromise) {
        dbg('model_wait_existing_promise', { target: safeModel });
        await modelLoadPromise;
        if (transcriber && currentModel === safeModel) {
            await showCachedBadge(prevState);
            return;
        }
    }

    modelLoadPromise = (async () => {
        try {
            setActionState(prevState, { type: 'download', color: ICON_COLORS().downloading });
            await loadModel(safeModel);
            setActionState(prevState, { type: 'download', color: ICON_COLORS().downloaded });
        } catch (err) {
            console.error("Model load failed:", err);
            dbg('model_load_error', { model: safeModel, error: String(err) });
            setActionState(prevState, { type: 'download', color: ICON_COLORS().download_error });
            await disposeCurrentModel();
            if (safeModel !== 'Xenova/whisper-tiny') {
                try {
                    setActionState(prevState, { type: 'download', color: ICON_COLORS().downloading });
                    await loadModel('Xenova/whisper-tiny');
                    setActionState(prevState, { type: 'download', color: ICON_COLORS().downloaded });
                } catch (e2) {
                    setActionState(prevState, { type: 'download', color: ICON_COLORS().download_error });
                    await disposeCurrentModel();
                    throw e2;
                }
            } else {
                throw err;
            }
        } finally {
            if (prevState !== 'processing') {
                setTimeout(() => {
                    if (currentState === prevState && currentBadge?.type === 'download') {
                        setActionState(prevState, null);
                    }
                }, 1000);
            }
            modelLoadPromise = null;
        }
    })();

    await modelLoadPromise;
}

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
        if (pollJson.status === 'completed') {
            return (pollJson.text || '').trim();
        }
        if (pollJson.status === 'error') {
            throw new Error(pollJson.error || 'AssemblyAI transcription error');
        }
    }
}

// TRANSCRIBE handling (tracks recognition tabs)
browser.runtime.onMessage.addListener((message, sender) => {
    if (message.type === 'CONFIG_CHANGED') return;

    if (message.type === 'TRANSCRIBE_AUDIO') {
        const tabId = sender?.tab?.id;
        const frameId = sender?.frameId;
        if (tabId == null) return;

        activeRecognitionTabs.add(tabId);

        const hostname = message.hostname || '';
        const sessionId = message.sessionId || 0;

        setActionState('processing', null);

        if (processingFallback.timer) clearTimeout(processingFallback.timer);
        processingFallback.tabId = tabId;
        processingFallback.timer = setTimeout(() => {
            processingFallback.timer = null;
            processingFallback.tabId = null;
            setActionState('idle', null);
            scheduleModelGc();
            dbg('processing_timeout', { tabId, sessionId });
        }, PROCESSING_TIMEOUT_MS);

        const lastEntry = lastSessionByTab.get(tabId);
        const lastSessionForHost = (lastEntry && lastEntry.hostname === hostname) ? lastEntry.sessionId : 0;
        if (lastEntry && lastEntry.hostname !== hostname) {
            lastSessionByTab.set(tabId, { sessionId: 0, hostname });
        }
        if (sessionId <= lastSessionForHost) {
            dbg('session_ignored_stale', { tabId, sessionId, lastSessionForHost, hostname });
            if (processingFallback.timer) { clearTimeout(processingFallback.timer); processingFallback.timer = null; }
            processingFallback.tabId = null;
            setActionState('idle', null);
            scheduleModelGc();
            return;
        }
        lastSessionByTab.set(tabId, { sessionId, hostname });

        if (inflightByTab.get(tabId)) return;
        inflightByTab.set(tabId, true);

        (async () => {
            const options = { frameId: frameId };
            const t0 = performance.now();
            try {
                const settings = await getEffectiveSettings(hostname);
                const { model, language, graceEnabled, graceMs, provider, assemblyaiApiKey } = settings;

                dbg('transcribe_start', { tabId, sessionId, hostname, provider, model, language, graceEnabled, graceMs });

                const audioBlob = new Blob([new Uint8Array(message.audioData)], { type: 'audio/wav' });
                const rawInput = await readAudio(audioBlob);

                const tRead = performance.now();

                const input = trimSilence(rawInput);
                if (!input) {
                    dbg('audio_drop_silence', { tabId, sessionId, rawLen: rawInput?.length || 0 });
                    browser.tabs.sendMessage(tabId, { type: 'WHISPER_NO_AUDIO', reason: 'silence' }, options);
                    return;
                }

                const trimmedLen = input.length;
                dbg('audio_trimmed', { tabId, sessionId, rawLen: rawInput.length, trimmedLen });

                // Cancelled before we start heavy work
                if (isCanceled(tabId, sessionId)) {
                    dbg('transcribe_abort_prework', { tabId, sessionId });
                    inflightByTab.delete(tabId);
                    if (processingFallback.timer) { clearTimeout(processingFallback.timer); processingFallback.timer = null; }
                    setActionState('idle', null);
                    scheduleModelGc();
                    return;
                }

                let text = '';

                if (provider === PROVIDERS.ASSEMBLY) {
                    if (!assemblyaiApiKey) {
                        throw new Error('AssemblyAI API key missing. Set it in the options page.');
                    }
                    const langToUse = (language && language !== 'auto') ? language : null;
                    const tAsmStart = performance.now();
                    text = await transcribeWithAssemblyAI(audioBlob, langToUse, assemblyaiApiKey);
                    dbg('asm_timing', { tabId, sessionId, ms: Math.round(performance.now() - tAsmStart) });
                } else {
                    await ensureModel(model);
                    if (!transcriber) throw new Error("Model not loaded");

                    const isEnglishModel = currentModel.endsWith(".en");
                    let langToUse = isEnglishModel ? 'en' : (language !== 'auto' ? language : null);

                    const tInferStart = performance.now();
                    const output = await transcriber(input, {
                        chunk_length_s: 30,
                        stride_length_s: 5,
                        language: langToUse,
                        task: 'transcribe',
                        temperature: 0
                    });
                    text = (output.text || '').trim();
                    dbg('local_infer_timing', { tabId, sessionId, ms: Math.round(performance.now() - tInferStart), langToUse, model: currentModel });
                }

                text = collapseRepeats(text);

                // Guard: ultra-short/low-content -> treat as unintelligible and clear timers
                {
                    const trimmed = text.trim();
                    const words = trimmed.split(/\s+/).filter(Boolean);
                    if (trimmed.length < 6 || words.length <= 1) {
                        dbg('text_too_short', { tabId, sessionId, text });
                        if (processingFallback.timer) { clearTimeout(processingFallback.timer); processingFallback.timer = null; }
                        processingFallback.tabId = null;
                        browser.tabs.sendMessage(tabId, { type: 'WHISPER_NO_AUDIO' }, options);
                        browser.tabs.sendMessage(tabId, { type: 'WHISPER_UNINTELLIGIBLE' }, options);
                        browser.runtime.sendMessage({ type: 'PROCESSING_DONE', status: 'noaudio' });
                        setActionState('idle', null);
                        scheduleModelGc();
                        return;
                    }
                }

                // if still pathological, treat as unintelligible
                if (isPathological(text)) {
                    dbg('text_pathological', { tabId, sessionId, text });
                    browser.tabs.sendMessage(tabId, { type: 'WHISPER_NO_AUDIO' }, options);
                    browser.tabs.sendMessage(tabId, { type: 'WHISPER_UNINTELLIGIBLE' }, options);
                    return;
                }

                if (isCanceled(tabId, sessionId)) {
                    dbg('transcribe_abort_post', { tabId, sessionId });
                    if (processingFallback.timer) { clearTimeout(processingFallback.timer); processingFallback.timer = null; }
                    setActionState('idle', null);
                    scheduleModelGc();
                    return;
                }

                const unintelligible =
                    !text ||
                    text === "" ||
                    text.includes("[BLANK_AUDIO]") ||
                    text.includes("[inaudible]") ||
                    text.includes("[INAUDIBLE]");

                if (unintelligible) {
                    dbg('text_unintelligible', { tabId, sessionId, text });
                    browser.tabs.sendMessage(tabId, { type: 'WHISPER_NO_AUDIO' }, options);
                    browser.tabs.sendMessage(tabId, { type: 'WHISPER_UNINTELLIGIBLE' }, options);
                } else {
                    dbg('transcribe_success', {
                        tabId,
                        sessionId,
                        msTotal: Math.round(performance.now() - t0),
                        msRead: Math.round(tRead - t0),
                        lenChars: text.length
                    });
                    sendResultWithGrace(tabId, sessionId, text, options, graceEnabled, graceMs);
                }
            } catch (err) {
                console.error(err);
                dbg('transcribe_error', { tabId, sessionId, error: String(err) });
                browser.tabs.sendMessage(tabId, { type: 'WHISPER_ERROR', error: err.message }, options);
                setActionState('error', null);
            } finally {
                inflightByTab.delete(tabId);
            }
        })();
    }
});

// When tabs close, clear tracking and unload only if idle and no recognition tabs remain
browser.tabs.onRemoved.addListener(async (tabId) => {
    clearOptionsUnloadTimer(tabId);
    clearTabTracking(tabId);
    extensionTabIds.delete(tabId);
    if (processingFallback.tabId === tabId && processingFallback.timer) {
        clearTimeout(processingFallback.timer);
        processingFallback.timer = null;
        processingFallback.tabId = null;
    }
    if (isBusy()) return;
    if (activeRecognitionTabs.size === 0) {
        await disposeCurrentModel();
        setActionState('idle', null);
        if (extensionTabIds.size === 0) {
            reloadPending = false;
            browser.runtime.reload();
        } else {
            reloadPending = true;
        }
    } else {
        scheduleModelGc();
    }
});