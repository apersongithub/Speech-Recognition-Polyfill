// background.js (MV2) - VAD, dynamic icon colors, dark-mode awareness, ack-based icon state, i18n titles

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
const lastSessionByTab = new Map();
let modelLoadPromise = null;

const isDarkMode = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => setActionState(currentState));

const ICON_COLORS = () => ({
    idle: isDarkMode() ? '#e5e7eb' : '#374151',
    recording: '#2563eb',
    processing: '#f59e0b',
    error: '#dc2626'
});

let currentState = 'idle';
const iconCache = new Map(); // color -> {16,19,32,38: ImageData}
const processingFallback = { timer: null, tabId: null };
let errorResetTimer = null;

function t(key, fallback) {
    return (browser.i18n && browser.i18n.getMessage(key)) || fallback;
}

function colorizeSvg(svgText, color) {
    let s = svgText
        .replace(/fill="context-fill"/g, `fill="${color}"`)
        .replace(/fill='context-fill'/g, `fill="${color}"`)
        .replace(/fill-opacity="context-fill-opacity"/g, `fill-opacity="1"`)
        .replace(/fill-opacity='context-fill-opacity'/g, `fill-opacity="1"`);
    if (!/\<svg[^>]*\sfill=/.test(s)) {
        s = s.replace('<svg', `<svg fill="${color}"`);
    }
    return s;
}

async function getIconImageData(color) {
    const key = String(color);
    if (iconCache.has(key)) return iconCache.get(key);
    const svgURL = browser.runtime.getURL('images/microphone.svg');
    const rawSvg = await (await fetch(svgURL)).text();
    const coloredSvg = colorizeSvg(rawSvg, color);
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(coloredSvg);
    const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = dataUrl;
    });
    const sizes = [16, 19, 32, 38];
    const out = {};
    for (const size of sizes) {
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        out[size] = ctx.getImageData(0, 0, size, size);
    }
    iconCache.set(key, out);
    return out;
}

async function setActionState(state) {
    currentState = state;
    const colors = ICON_COLORS();
    let color = colors.idle;
    let title = t('title_idle', 'Whisper: Idle');
    if (state === 'recording') { color = colors.recording; title = t('title_recording', 'Whisper: Listening'); }
    else if (state === 'processing') { color = colors.processing; title = t('title_processing', 'Whisper: Processing'); }
    else if (state === 'error') { color = colors.error; title = t('title_error', 'Whisper: Error'); }

    try {
        const images = await getIconImageData(color);
        await browser.browserAction.setIcon({ imageData: images });
    } catch (e) { console.warn('Failed to set icon', e); }
    try { await browser.browserAction.setTitle({ title }); } catch (e) {}
}

function setErrorBriefly(ms = 3000) {
    if (errorResetTimer) clearTimeout(errorResetTimer);
    setActionState('error');
    errorResetTimer = setTimeout(() => {
        errorResetTimer = null;
        setActionState('idle');
    }, ms);
}

browser.runtime.onInstalled.addListener(async (details) => {
    if (details?.reason === 'install') {
        try { await browser.runtime.openOptionsPage(); }
        catch { try { await browser.tabs.create({ url: browser.runtime.getURL('options.html') }); } catch (_) {} }
    }
    setActionState('idle');
});
browser.runtime.onStartup?.addListener(() => setActionState('idle'));

browser.runtime.onMessage.addListener((message, sender) => {
    // Normal "done" ack
    if (message?.type === 'PROCESSING_DONE') {
        if (processingFallback.timer) { clearTimeout(processingFallback.timer); processingFallback.timer = null; }
        processingFallback.tabId = null;
        setActionState('idle');
        return;
    }

    // NEW: unintelligible / no-meaningful-speech after processing
    if (message?.type === 'UNINTELLIGIBLE_SPEECH') {
        if (processingFallback.timer) { clearTimeout(processingFallback.timer); processingFallback.timer = null; }
        processingFallback.tabId = null;
        // show red mic briefly
        setErrorBriefly(3500);
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
    if (!hostname) return defaults;
    const overrides = settings?.overrides || {};
    const site = overrides[hostname] || {};
    return {
        model: (site.model && ALLOWED_MODELS.has(site.model)) ? site.model : (ALLOWED_MODELS.has(defaults.model) ? defaults.model : 'Xenova/whisper-tiny'),
        language: site.language ?? defaults.language ?? 'auto',
        silenceTimeoutMs: site.silenceTimeoutMs ?? defaults.silenceTimeoutMs ?? 1500
    };
}

async function loadModel(modelID) {
    console.log(`Loading Model: ${modelID}`);
    transcriber = await pipeline('automatic-speech-recognition', modelID, { device: currentBackend });
    currentModel = modelID;
}
async function ensureModel(modelID) {
    const safeModel = ALLOWED_MODELS.has(modelID) ? modelID : 'Xenova/whisper-tiny';
    if (transcriber && currentModel === safeModel) return;
    if (modelLoadPromise) {
        await modelLoadPromise;
        if (transcriber && currentModel === safeModel) return;
    }
    modelLoadPromise = (async () => {
        try { await loadModel(safeModel); }
        catch (err) {
            console.error("Model load failed:", err);
            if (safeModel !== 'Xenova/whisper-tiny') await loadModel('Xenova/whisper-tiny');
            else throw err;
        } finally { modelLoadPromise = null; }
    })();
    await modelLoadPromise;
}

async function readAudio(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const audioContext = new AudioContext({ sampleRate: 16000 });
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    return audioBuffer.getChannelData(0);
}

browser.runtime.onMessage.addListener((message, sender) => {
    if (message.type === 'CONFIG_CHANGED') return;

    if (message.type === 'RECORDING_STATE') {
        setActionState(message.state === 'recording' ? 'recording' : 'idle');
        return;
    }

    if (message.type === 'TRANSCRIBE_AUDIO') {
        const tabId = sender?.tab?.id;
        const frameId = sender?.frameId;
        if (tabId == null) return;

        setActionState('processing');

        if (processingFallback.timer) clearTimeout(processingFallback.timer);
        processingFallback.tabId = tabId;
        processingFallback.timer = setTimeout(() => {
            processingFallback.timer = null;
            processingFallback.tabId = null;
            setActionState('idle');
        }, 20000);

        const sessionId = message.sessionId || 0;
        const last = lastSessionByTab.get(tabId) || 0;
        if (sessionId <= last) return;
        lastSessionByTab.set(tabId, sessionId);

        if (inflightByTab.get(tabId)) return;
        inflightByTab.set(tabId, true);

        (async () => {
            const options = { frameId: frameId };
            try {
                const hostname = message.hostname || '';
                const { model, language } = await getEffectiveSettings(hostname);

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

                const isEnglishModel = currentModel.endsWith(".en");
                let langToUse = isEnglishModel ? 'en' : (language !== 'auto' ? language : null);

                const output = await transcriber(input, {
                    chunk_length_s: 30,
                    stride_length_s: 5,
                    language: langToUse,
                    task: 'transcribe',
                    temperature: 0
                });

                const text = (output.text || '').trim();

                // Treat “empty-ish” output as unintelligible
                const unintelligible =
                    !text ||
                    text === "" ||
                    text.includes("[BLANK_AUDIO]") ||
                    text.includes("[inaudible]") ||
                    text.includes("[INAUDIBLE]");

                if (unintelligible) {
                    browser.tabs.sendMessage(tabId, { type: 'WHISPER_NO_AUDIO' }, options);
                    // content.js will also send PROCESSING_DONE, but we want a red mic signal
                    browser.tabs.sendMessage(tabId, { type: 'WHISPER_UNINTELLIGIBLE' }, options);
                } else {
                    browser.tabs.sendMessage(tabId, { type: 'WHISPER_RESULT_TO_PAGE_BRIDGE', text }, options);
                }
            } catch (err) {
                console.error(err);
                browser.tabs.sendMessage(tabId, { type: 'WHISPER_ERROR', error: err.message }, options);
                setActionState('error');
            } finally {
                inflightByTab.delete(tabId);
            }
        })();
    }
});