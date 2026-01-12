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

let transcriber = null;
let currentModel = 'Xenova/whisper-tiny';
let currentBackend = 'wasm';
const inflightByTab = new Map();
const lastSessionByTab = new Map(); // tabId -> { sessionId, hostname }
const canceledSessionsByTab = new Map(); // tabId -> Set(sessionId)
let modelLoadPromise = null;

const RESULT_GRACE_MS_DEFAULT = 450; // default grace window
const CANCEL_BADGE_MS = 1200;        // cancel badge display
const PROCESSING_TIMEOUT_MS = 12000; // tighter timeout to avoid long hangs

const MODEL_IDLE_UNLOAD_MS = 15_000; // unload model after 15s idle
let modelGcTimer = null;

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

async function setActionState(state, badge = null) {
    currentState = state;
    currentBadge = badge;
    const colors = ICON_COLORS();
    let color = colors.idle;
    let title = t('title_idle', 'Whisper: Idle');
    if (state === 'recording') { color = colors.recording; title = t('title_recording', 'Whisper: Listening'); }
    else if (state === 'processing') { color = colors.processing; title = t('title_processing', 'Whisper: Processing'); }
    else if (state === 'error') { color = colors.error; title = t('title_error', 'Whisper: Error'); }

    try {
        const images = await getIconImageData(color, badge);
        await browser.browserAction.setIcon({ imageData: images });
    } catch (e) { console.warn('Failed to set icon', e); }
    try { await browser.browserAction.setTitle({ title }); } catch (e) { }
}

function setErrorBriefly(ms = 3000) {
    if (errorResetTimer) clearTimeout(errorResetTimer);
    setActionState('error', null);
    errorResetTimer = setTimeout(() => {
        errorResetTimer = null;
        setActionState('idle', null);
    }, ms);
}

// cancel tracking
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
}

async function hasUsableTabs() {
    try {
        const tabs = await browser.tabs.query({});
        return tabs.some(t => {
            const u = t.url || '';
            // Filter out internal pages; count only real web pages
            return u && !u.startsWith('about:') && !u.startsWith('chrome:') && !u.startsWith('moz-extension:') && !u.startsWith('view-source:');
        });
    } catch (_) {
        // If query fails, assume there might be tabs to avoid over-aggressive dispose
        return true;
    }
}

// If force=true, dispose immediately; otherwise after idle timeout
function scheduleModelGc(force = false) {
    if (modelGcTimer) clearTimeout(modelGcTimer);
    const delay = force ? 0 : MODEL_IDLE_UNLOAD_MS;
    modelGcTimer = setTimeout(async () => {
        const hasInflight = inflightByTab.size > 0;
        const processing = processingFallback.timer !== null;
        const busy = hasInflight || processing || currentState === 'recording' || currentState === 'processing';
        const tabsExist = await hasUsableTabs();
        if (force) {
            if (!tabsExist || !busy) {
                if (processingFallback.timer) { clearTimeout(processingFallback.timer); processingFallback.timer = null; }
                processingFallback.tabId = null;
                await disposeCurrentModel();
                setActionState('idle', null);
            }
            return;
        }
        if (!busy && !tabsExist) {
            await disposeCurrentModel();
            setActionState('idle', null);
        }
    }, delay);
}

browser.runtime.onInstalled.addListener(async (details) => {
    if (details?.reason === 'install') {
        try { await browser.runtime.openOptionsPage(); }
        catch { try { await browser.tabs.create({ url: browser.runtime.getURL('options.html') }); } catch (_) { } }
    }
    setActionState('idle', null);
});
browser.runtime.onStartup?.addListener(() => setActionState('idle', null));

browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === 'CANCEL_SESSION') {
        const tabId = sender?.tab?.id;
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
        scheduleModelGc(true); // aggressive check after cancel
        return;
    }

    if (message?.type === 'PROCESSING_DONE') {
        if (processingFallback.timer) { clearTimeout(processingFallback.timer); processingFallback.timer = null; }
        processingFallback.tabId = null;

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
        setErrorBriefly(3500);
        scheduleModelGc();
        return;
    }
});

function trimSilence(audioData, sampleRate = 16000) {
    const threshold = 0.02;
    let start = 0, end = audioData.length;
    for (let i = 0; i < audioData.length; i++) { if (Math.abs(audioData[i]) > threshold) { start = i; break; } }
    for (let i = audioData.length - 1; i >= start; i--) { if (Math.abs(audioData[i]) > threshold) { end = i + 1; break; } }
    const trimmed = audioData.subarray(start, end);
    if (trimmed.length < sampleRate * 0.2) return null;
    return trimmed;
}

async function getEffectiveSettings(hostname) {
    const { settings } = await browser.storage.local.get('settings');
    const defaults = settings?.defaults || { model: 'Xenova/whisper-tiny', language: 'auto', silenceTimeoutMs: 1500 };
    const graceEnabled = settings?.graceEnabled !== false; // default true
    const graceMs = typeof settings?.graceMs === 'number' ? settings.graceMs : RESULT_GRACE_MS_DEFAULT;
    if (!hostname) return { model: defaults.model, language: defaults.language, silenceTimeoutMs: defaults.silenceTimeoutMs, graceEnabled, graceMs };
    const overrides = settings?.overrides || {};
    const site = overrides[hostname] || {};
    return {
        model: (site.model && ALLOWED_MODELS.has(site.model)) ? site.model : (ALLOWED_MODELS.has(defaults.model) ? defaults.model : 'Xenova/whisper-tiny'),
        language: site.language ?? defaults.language ?? 'auto',
        silenceTimeoutMs: site.silenceTimeoutMs ?? defaults.silenceTimeoutMs ?? 1500,
        graceEnabled,
        graceMs
    };
}

async function loadModel(modelID) {
    console.log(`Loading Model: ${modelID}`);
    transcriber = await pipeline('automatic-speech-recognition', modelID, { device: currentBackend });
    currentModel = modelID;
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
        return;
    }

    if (transcriber && currentModel !== safeModel) {
        await disposeCurrentModel();
    }

    if (modelLoadPromise) {
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

browser.runtime.onMessage.addListener((message, sender) => {
    if (message.type === 'CONFIG_CHANGED') return;

    if (message.type === 'RECORDING_STATE') {
        setActionState(message.state === 'recording' ? 'recording' : 'idle', null);
        return;
    }

    if (message.type === 'TRANSCRIBE_AUDIO') {
        const tabId = sender?.tab?.id;
        const frameId = sender?.frameId;
        if (tabId == null) return;

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
        }, PROCESSING_TIMEOUT_MS);

        const lastEntry = lastSessionByTab.get(tabId);
        const lastSessionForHost = (lastEntry && lastEntry.hostname === hostname) ? lastEntry.sessionId : 0;
        if (lastEntry && lastEntry.hostname !== hostname) {
            lastSessionByTab.set(tabId, { sessionId: 0, hostname });
        }
        if (sessionId <= lastSessionForHost) {
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
            try {
                const { model, language, graceEnabled, graceMs } = await getEffectiveSettings(hostname);

                await ensureModel(model);
                if (!transcriber) throw new Error("Model not loaded");

                const audioBlob = new Blob([new Uint8Array(message.audioData)], { type: 'audio/wav' });
                const rawInput = await readAudio(audioBlob);

                const input = trimSilence(rawInput);
                if (!input) {
                    console.log("Audio contained only silence/noise. Dropping.");
                    browser.tabs.sendMessage(tabId, { type: 'WHISPER_NO_AUDIO', reason: 'silence' }, options);
                    return;
                }

                if (isCanceled(tabId, sessionId)) {
                    inflightByTab.delete(tabId);
                    if (processingFallback.timer) { clearTimeout(processingFallback.timer); processingFallback.timer = null; }
                    setActionState('idle', null);
                    scheduleModelGc();
                    return;
                }

                const isEnglishModel = currentModel.endsWith(".en");
                let langToUse = isEnglishModel ? 'en' : (language !== 'auto' ? language : null);

                const output = await transcriber(input, {
                    chunk_length_s: 30,
                    stride_length_s: 5,
                    language: langToUse,
                    task: 'transcribe',
                    temperature: 0
                });

                let text = (output.text || '').trim();
                text = collapseRepeats(text);

                // if still pathological, treat as unintelligible
                if (isPathological(text)) {
                    browser.tabs.sendMessage(tabId, { type: 'WHISPER_NO_AUDIO' }, options);
                    browser.tabs.sendMessage(tabId, { type: 'WHISPER_UNINTELLIGIBLE' }, options);
                    return;
                }

                if (isCanceled(tabId, sessionId)) {
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
                    browser.tabs.sendMessage(tabId, { type: 'WHISPER_NO_AUDIO' }, options);
                    browser.tabs.sendMessage(tabId, { type: 'WHISPER_UNINTELLIGIBLE' }, options);
                } else {
                    sendResultWithGrace(tabId, sessionId, text, options, graceEnabled, graceMs);
                }
            } catch (err) {
                console.error(err);
                browser.tabs.sendMessage(tabId, { type: 'WHISPER_ERROR', error: err.message }, options);
                setActionState('error', null);
            } finally {
                inflightByTab.delete(tabId);
            }
        })();
    }
});

// When tabs close, clear tracking and, if no usable tabs remain, unload immediately
// In tabs.onRemoved listener, after disposeCurrentModel and setActionState:
browser.tabs.onRemoved.addListener(async (tabId) => {
    inflightByTab.delete(tabId);
    lastSessionByTab.delete(tabId);
    canceledSessionsByTab.delete(tabId);
    if (processingFallback.tabId === tabId && processingFallback.timer) {
        clearTimeout(processingFallback.timer);
        processingFallback.timer = null;
        processingFallback.tabId = null;
    }
    const tabsExist = await hasUsableTabs();
    if (!tabsExist) {
        await disposeCurrentModel();
        setActionState('idle', null);
        // Force full unload to return WASM/JS code memory to the OS
        browser.runtime.reload();
    } else {
        scheduleModelGc(true);
    }
});