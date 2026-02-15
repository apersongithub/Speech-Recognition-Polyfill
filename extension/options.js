// options.js
const ALLOWED_MODELS = [
    'Xenova/whisper-tiny.en',
    'Xenova/whisper-tiny',
    'Xenova/whisper-base.en',
    'Xenova/whisper-base',
    'Xenova/whisper-small.en',
    'Xenova/whisper-small',
    'Xenova/distil-whisper-medium.en'
];

const DEFAULT_VOSK_MODEL = 'vosk-model-small-en-us-0.15';
const ALLOWED_PROVIDERS = ['local-whisper', 'assemblyai', 'vosk'];

const VOSK_MODEL_INDEX_URL = 'https://alphacephei.com/vosk/models/model-list.json';

const MIC_GAIN_MIN = 1.0;
const MIC_GAIN_MAX = 3.0;
const MIC_GAIN_DEFAULT = 1.0;

const SILENCE_SENSITIVITY_MIN = 6;
const SILENCE_SENSITIVITY_MAX = 20;
const SILENCE_SENSITIVITY_DEFAULT = 12;

let isRestoring = false;
let capturingHotkey = false;
let lastHotkeyValue = 'Alt+A';
const statusTimers = new Map();

// prevent UI echo loops while applying storage changes
let isApplyingExternalUpdate = false;

// remember selection in overrides list
let selectedOverrideHost = null;

// dropdown state for list visibility
let overridesListOpen = false;

// Vosk model index (loaded from model-list.json)
let voskModelIndex = new Map();
let voskModelIndexPromise = null;

async function broadcastConfigChanged() {
    try {
        try { browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' }); } catch (_) { }

        const tabs = await browser.tabs.query({});
        await Promise.allSettled(
            tabs
                .filter(t => typeof t.id === 'number')
                .map(t => browser.tabs.sendMessage(t.id, { type: 'CONFIG_CHANGED' }))
        );
    } catch (_) { }
}

document.addEventListener('DOMContentLoaded', () => {
    applyI18n();
    restoreOptions();
    installLiveSettingsListener();
    installOverridesListToggle();
    installOverrideRowClickToLoad();

    ensureVoskModelIndex().then(() => checkVoskModelSize()).catch(() => { });

    refreshBackendIndicator().catch(() => { });
    // Change 2000 (2s) to 30000 (30s) or remove it
setInterval(() => refreshBackendIndicator().catch(() => { }), 30000);
});

document.getElementById('open-assemblyai')?.addEventListener('click', () => {
    browser.tabs.create({ url: 'https://www.assemblyai.com/dashboard/api-keys', active: true });
});
document.getElementById('add-override')?.addEventListener('click', addOrUpdateOverride);
document.getElementById('remove-override')?.addEventListener('click', removeAllOverrides);

document.getElementById('debug-mode')?.addEventListener('change', () => saveDebugMode(['dev']));
document.getElementById('disable-processing-timeouts')?.addEventListener('change', () => {
    if (!isRestoring) saveDefaults(['dev']);
});
document.getElementById('grace-ms')?.addEventListener('change', () => saveGraceSetting(['speech-logic']));
document.getElementById('factory-reset')?.addEventListener('click', factoryReset);
document.getElementById('disable-favicons')?.addEventListener('change', () => toggleFavicons(['dev']));

document.getElementById('show-model-sections-toggle')?.addEventListener('change', () => {
    if (!isRestoring) saveDefaults(['engine']);
    applyVisibility();
});
document.getElementById('provider-select')?.addEventListener('change', () => {
    if (!isRestoring) saveDefaults(['engine']);
    applyVisibility();
});
document.getElementById('enable-hardcap')?.addEventListener('change', () => {
    if (!isRestoring) saveDefaults(['speech-logic']);
});
document.getElementById('disable-grace-window')?.addEventListener('change', () => {
    if (!isRestoring) saveGraceSetting(['speech-logic']);
});
document.getElementById('cache-default-model')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['engine']); });
document.getElementById('strip-trailing-period')?.addEventListener('change', () => {
    if (!isRestoring) saveDefaults(['speech-triggers']);
});
document.getElementById('assemblyai-streaming')?.addEventListener('change', () => {
    if (!isRestoring) saveDefaults(['speech-logic']);
});
document.getElementById('assemblyai-streaming-multilingual')?.addEventListener('change', () => {
    if (!isRestoring) saveDefaults(['speech-logic']);
});
document.getElementById('disable-space-normalization')?.addEventListener('change', () => {
    if (!isRestoring) saveDefaults(['speech-triggers']);
});

document.getElementById('assemblyai-streaming-silence-always')?.addEventListener('change', (e) => {
    const neverEl = document.getElementById('assemblyai-streaming-silence-never');
    const partialEl = document.getElementById('assemblyai-streaming-silence-partial');
    if (e.target.checked) {
        if (neverEl) neverEl.checked = false;
        if (partialEl) partialEl.checked = false;
    }
    if (!isRestoring) saveDefaults(['speech-logic']);
});
document.getElementById('assemblyai-streaming-silence-never')?.addEventListener('change', (e) => {
    const alwaysEl = document.getElementById('assemblyai-streaming-silence-always');
    const partialEl = document.getElementById('assemblyai-streaming-silence-partial');
    if (e.target.checked) {
        if (alwaysEl) alwaysEl.checked = false;
        if (partialEl) partialEl.checked = false;
    }
    if (!isRestoring) saveDefaults(['speech-logic']);
});
document.getElementById('assemblyai-streaming-silence-partial')?.addEventListener('change', (e) => {
    const alwaysEl = document.getElementById('assemblyai-streaming-silence-always');
    const neverEl = document.getElementById('assemblyai-streaming-silence-never');
    if (e.target.checked) {
        if (alwaysEl) alwaysEl.checked = false;
        if (neverEl) neverEl.checked = false;
    }
    if (!isRestoring) saveDefaults(['speech-logic']);
});

document.getElementById('enable-shortcut')?.addEventListener('change', () => {
    if (!isRestoring) saveDefaults(['speech-triggers']);
});
document.getElementById('send-enter-after')?.addEventListener('change', () => {
    if (!isRestoring) saveDefaults(['speech-triggers']);
});

document.getElementById('toast-notifications')?.addEventListener('change', () => {
    if (!isRestoring) saveDefaults(['dev']);
});
document.getElementById('hide-warning-banner')?.addEventListener('change', () => {
    if (!isRestoring) saveDefaults(['dev']);
    applyBannerVisibility(document.getElementById('hide-warning-banner')?.checked === true);
});

document.getElementById('mic-gain')?.addEventListener('input', () => {
    updateMicGainDisplay();
    if (!isRestoring) saveDefaults(['speech-logic']);
});
document.getElementById('silence-sensitivity')?.addEventListener('input', () => {
    updateSilenceSensitivityDisplay();
    if (!isRestoring) saveDefaults(['speech-logic']);
});

const voskModelInput = document.getElementById('vosk-model-input');
if (voskModelInput) {
    voskModelInput.addEventListener('input', () => {
        checkVoskModelSize();
    });
    voskModelInput.addEventListener('change', () => {
        if (!isRestoring) saveDefaults(['vosk']);
    });
}

// import/export
document.getElementById('export-settings')?.addEventListener('click', exportSettingsToFile);
document.getElementById('import-settings')?.addEventListener('click', () => document.getElementById('import-file')?.click());
document.getElementById('import-file')?.addEventListener('change', importSettingsFromFile);

// extra listeners
document.getElementById('clear-override-inputs')?.addEventListener('click', clearOverrideInputs);

// hotkey capture (unchanged behavior)
const hotkeyInput = document.getElementById('hotkey');
if (hotkeyInput) {
    hotkeyInput.addEventListener('focus', () => {
        capturingHotkey = true;
        hotkeyInput.value = '';
    });
    hotkeyInput.addEventListener('blur', () => {
        capturingHotkey = false;
        ensureHotkeyValue(true);
    });
    hotkeyInput.addEventListener('keydown', (e) => {
        if (!capturingHotkey) return;
        e.preventDefault();

        if (e.key === 'Backspace' || e.key === 'Delete') {
            ensureHotkeyValue(true);
            capturingHotkey = false;
            hotkeyInput.blur();
            return;
        }
        if (e.key === 'Escape') {
            capturingHotkey = false;
            const enableChk = document.getElementById('enable-shortcut');
            if (enableChk) enableChk.checked = false;
            ensureHotkeyValue(true);
            hotkeyInput.blur();
            return;
        }

        const combo = buildHotkeyString(e);
        if (!combo) return;
        hotkeyInput.value = combo;
        lastHotkeyValue = combo;
        capturingHotkey = false;
        const enableChk = document.getElementById('enable-shortcut');
if (enableChk) enableChk.checked = false;
        hotkeyInput.blur();
        saveDefaults(['speech-triggers']);
    });
}

function t(key, fallback = '') { return browser.i18n?.getMessage(key) || fallback; }

function applyI18n() {
    const titleMsg = t('options_page_title');
    if (titleMsg) document.title = titleMsg;

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const msg = t(key);
        if (!msg) return;

        const tag = el.tagName;

        if (tag === 'OPTGROUP') { el.label = msg; return; }
        if (tag === 'OPTION') { el.textContent = msg; return; }

        if (typeof msg === 'string' && /<\/?[a-z][\s\S]*>/i.test(msg)) {
            el.innerHTML = msg;
        } else if (el.children && el.children.length > 0) {
            return;
        } else {
            el.textContent = msg;
        }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        const msg = t(key);
        if (!msg) return;
        el.setAttribute('placeholder', msg);
    });

    const hostInput = document.getElementById('override-host');
    if (hostInput) hostInput.placeholder = t('hostname_placeholder', hostInput.placeholder || 'example.com');

    const timeoutOverride = document.getElementById('override-timeout');
    if (timeoutOverride) timeoutOverride.placeholder = t('override_timeout_placeholder', timeoutOverride.placeholder || '(Default)');
}

function clampTimeout(val) {
    const n = parseInt(val, 10);
    if (Number.isNaN(n)) return null;
    return Math.max(500, Math.min(5000, n));
}
function clampGrace(val) {
    const n = parseInt(val, 10);
    if (Number.isNaN(n)) return 450;
    return Math.max(0, Math.min(2000, n));
}
function parseGraceOverride(val) {
    const n = parseInt(val, 10);
    if (Number.isNaN(n)) return null;
    return Math.max(0, Math.min(2000, n));
}
function normalizeProvider(p) {
    return ALLOWED_PROVIDERS.includes(p) ? p : 'vosk';
}

async function ensureVoskModelIndex() {
    if (voskModelIndexPromise) return voskModelIndexPromise;

    voskModelIndexPromise = (async () => {
        try {
            const resp = await fetch(VOSK_MODEL_INDEX_URL);
            if (!resp.ok) throw new Error(`Failed to fetch Vosk models: ${resp.status}`);
            const data = await resp.json();
            const list = parseVoskModelList(data);
            if (list.length > 0) {
                voskModelIndex = new Map(list.map(m => [m.id, m]));
                setVoskModelDatalist(list);
                return true;
            }
        } catch (e) {
            console.warn('[Options] Failed to load Vosk model list', e);
        }
        return false;
    })();

    try {
        return await voskModelIndexPromise;
    } finally {
        voskModelIndexPromise = null;
    }
}

function normalizeVoskModel(id, fallbackModel = DEFAULT_VOSK_MODEL) {
    const candidate = (id || '').trim();
    if (!candidate) return fallbackModel;

    if (voskModelIndex.size > 0) {
        return voskModelIndex.has(candidate) ? candidate : fallbackModel;
    }

    return candidate;
}

function formatSize(size) {
    const n = typeof size === 'number' ? size : parseFloat(size);
    if (!Number.isFinite(n)) return null;

    // If size looks like bytes, convert to MB
    const bytes = n > 1_000_000 ? n : n * 1024 * 1024;
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${Math.round(mb)} MB`;
}

function sizeToMb(size) {
    const n = typeof size === 'number' ? size : parseFloat(size);
    if (!Number.isFinite(n)) return null;
    const bytes = n > 1_000_000 ? n : n * 1024 * 1024;
    return bytes / (1024 * 1024);
}

function checkModelSize() {
    const model = document.getElementById('model-select')?.value;
    const warningBox = document.getElementById('size-warning');
    if (!warningBox || !model) return;
    warningBox.style.display = 'none';

    if (model.includes("small") || model.includes("distil-whisper")) {
        warningBox.style.display = 'block';
        warningBox.textContent = t('size_warning', "⚠️ Heavy Model: First run will be slow. If it crashes, use Base or Tiny.");
    }
}

function checkVoskModelSize() {
    const model = document.getElementById('vosk-model-input')?.value?.trim();
    const warningBox = document.getElementById('vosk-size-warning');
    if (!warningBox) return;
    warningBox.style.display = 'none';

    if (!model) return;

    const meta = voskModelIndex.get(model);
    if (meta?.size) {
        const formatted = formatSize(meta.size);
        const sizeNum = typeof meta.size === 'number' ? meta.size : parseFloat(meta.size);
        const bytes = sizeNum > 1_000_000 ? sizeNum : sizeNum * 1024 * 1024;
        const mb = bytes / (1024 * 1024);

        if (formatted && mb >= 500) {
            warningBox.style.display = 'block';
            warningBox.textContent = `⚠️ Large Vosk model: ${formatted}. First load will be slow and memory-heavy.`;
        }
        return;
    }

    if (/large|gigaspeech|big/i.test(model)) {
        warningBox.style.display = 'block';
        warningBox.textContent = t('vosk_size_warning', "⚠️ Large Vosk model: first load will be slow and memory-heavy.");
    }
}

// --- In options.js ---

function autoPrettifyVoskId(id) {
    let s = id.replace(/^vosk-model-/, '').replace(/-/g, ' ');
    s = s.replace(/\b\w/g, l => l.toUpperCase());

    const langMap = {
        'En Us': 'English (US)',
        'En In': 'English (India)',
        'En':    'English',
        'Cn':    'Chinese',
        'Ru':    'Russian',
        'Fr':    'French',
        'De':    'German',
        'Es':    'Spanish',
        'Pt':    'Portuguese',
        'It':    'Italian',
        'Tr':    'Turkish',
        'Vn':    'Vietnamese',
        'Ja':    'Japanese',
        'Hi':    'Hindi',
        'Fa':    'Persian',
        'Uk':    'Ukrainian',
        'Kz':    'Kazakh',
        'Sv':    'Swedish',
        'Ca':    'Catalan',
        'Ar':    'Arabic', // Added
        'Nl':    'Dutch',  // Added
        'Ni':    'Dutch',  // Added per your observation
        'El Gr': 'Greek'
    };

    Object.keys(langMap).sort((a, b) => b.length - a.length).forEach(code => {
        const re = new RegExp(`\\b${code}\\b`, 'g');
        s = s.replace(re, langMap[code]);
    });

    return s;
}

// --- In options.js ---

// 1. Update Parser to capture 'version'
function parseVoskModelList(payload) {
  const list = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.models) ? payload.models : []);
  
  return list.map((entry) => {
    const id = entry?.name || entry?.id || entry?.model || entry?.model_id;
    if (!id) return null;

    return { 
        id, 
        url: entry?.url || entry?.link || entry?.download, 
        size: entry?.size,
        langText: entry?.lang_text,
        sizeText: entry?.size_text,
        type: entry?.type,
        obsolete: (entry?.obsolete === 'true' || entry?.obsolete === true),
        version: entry?.version // NEW: Capture version
    };
  }).filter(Boolean);
}

// 2. Update Display Logic
window.VOSK_PRETTY_TO_ID = new Map();
window.VOSK_ID_TO_PRETTY = new Map();

function setVoskModelDatalist(list) {
    const datalist = document.getElementById('vosk-model-list');
    const realInput = document.getElementById('vosk-model-input'); // Options ID
    
    if (!datalist || !realInput) return;
    
    datalist.innerHTML = '';
    window.VOSK_PRETTY_TO_ID.clear();
    window.VOSK_ID_TO_PRETTY.clear();

    // --- Shadow Input Logic (Same as before) ---
    let prettyInput = document.getElementById('vosk-model-pretty-display');
    if (!prettyInput) {
        prettyInput = document.createElement('input');
        prettyInput.id = 'vosk-model-pretty-display';
        prettyInput.type = 'text';
        prettyInput.className = realInput.className;
        prettyInput.placeholder = "Select a model...";
        prettyInput.style.width = "100%";
        
        prettyInput.setAttribute('list', 'vosk-model-list');
        realInput.removeAttribute('list');
        realInput.style.display = 'none';
        realInput.parentNode.insertBefore(prettyInput, realInput);

        prettyInput.addEventListener('input', () => {
            const val = prettyInput.value;
            const id = window.VOSK_PRETTY_TO_ID.get(val);
            if (id) realInput.value = id;
            else realInput.value = val;
            
            realInput.dispatchEvent(new Event('change'));
            realInput.dispatchEvent(new Event('input'));
        });
    }

    // --- Filter & Sort ---
    const filtered = list.filter((model) => {
        const mb = sizeToMb(model?.size);
        return (mb == null || mb <= 1042) && !/spk|tts/i.test(model.id);
    });

    const sorted = filtered.sort((a, b) => {
        if (a.obsolete !== b.obsolete) return a.obsolete ? 1 : -1;
        return a.id.localeCompare(b.id);
    });

    // --- Build List with Version ---
    for (const model of sorted) {
        const option = document.createElement('option');
        
        let prettyName = model.langText || autoPrettifyVoskId(model.id);
        
        const extras = [];
        
        // NEW: Add Version first
        if (model.version) extras.push(`v${model.version}`);

        // Add Type (skip if standard small/big is obvious or redundant)
        if (model.type && model.type !== 'small') extras.push(model.type);
        else if (model.id.includes('small') && !model.type) extras.push('small');
        
        // Add Size
        if (model.sizeText) extras.push(model.sizeText);
        
        // Combine: "English (v0.15, small, 50MiB)"
        if (extras.length > 0) prettyName += ` (${extras.join(', ')})`;

        if (model.obsolete) prettyName = `⚠️ [OBSOLETE] ${prettyName}`;

        window.VOSK_PRETTY_TO_ID.set(prettyName, model.id);
        window.VOSK_ID_TO_PRETTY.set(model.id, prettyName);

        option.value = prettyName; 
        datalist.appendChild(option);
    }

    if (realInput.value) {
        const pretty = window.VOSK_ID_TO_PRETTY.get(realInput.value);
        if (pretty) prettyInput.value = pretty;
        else prettyInput.value = realInput.value;
    }
}

// Replace the existing normalizeHost function with this robust implementation:
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

  // NOTE: Do NOT strip "www." — preserve exact host as entered.
  return host;
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

function updateMicGainDisplay() {
    const el = document.getElementById('mic-gain');
    const out = document.getElementById('mic-gain-value');
    if (!el || !out) return;
    const value = clampMicGain(el.value);
    out.textContent = `${value.toFixed(1)}x`;

    const isDanger = value > 1.8;
    el.classList.toggle('range-danger', isDanger);
    out.classList.toggle('range-value-danger', isDanger);

    const root = document.documentElement;
    const dangerColor = getComputedStyle(root).getPropertyValue('--danger').trim() || '#ef4444';
    el.style.accentColor = isDanger ? dangerColor : '';
}

function updateSilenceSensitivityDisplay() {
    const el = document.getElementById('silence-sensitivity');
    const out = document.getElementById('silence-sensitivity-value');
    if (!el || !out) return;
    out.textContent = String(clampSilenceSensitivity(el.value));
}

function applyBannerVisibility(hidden) {
    const banner = document.getElementById('top-warning-banner');
    if (!banner) return;
    banner.style.display = hidden ? 'none' : '';
}

function applyVisibility() {
    const showToggle = document.getElementById('show-model-sections-toggle')?.checked === true;
    const hideModelSections = !showToggle;
    const provider = document.getElementById('provider-select')?.value || 'vosk';
    const cardLocal = document.getElementById('card-local');
    const cardCloud = document.getElementById('card-cloud');
    const cardVosk = document.getElementById('card-vosk');
    if (!cardLocal || !cardCloud || !cardVosk) return;

    if (!hideModelSections) {
        cardLocal.style.display = '';
        cardCloud.style.display = '';
        cardVosk.style.display = '';
        return;
    }
    if (provider === 'assemblyai') {
        cardLocal.style.display = 'none';
        cardVosk.style.display = 'none';
        cardCloud.style.display = '';
    } else if (provider === 'vosk') {
        cardLocal.style.display = 'none';
        cardVosk.style.display = '';
        cardCloud.style.display = 'none';
    } else {
        cardLocal.style.display = '';
        cardVosk.style.display = 'none';
        cardCloud.style.display = 'none';
    }
}

function buildHotkeyString(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.metaKey) mods.push('Meta');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');

    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;

    let keyPart = '';
    if (e.key === ' ') keyPart = 'Space';
    else if (e.key.length === 1) keyPart = e.key.toUpperCase();
    else keyPart = e.key;

    return [...mods, keyPart].join('+');
}

function hideAllStatusBadges() {
    document.querySelectorAll('.status').forEach(el => {
        el.style.opacity = '0';
        el.classList.remove('saved-pulse');
    });
    statusTimers.forEach(timer => clearTimeout(timer));
    statusTimers.clear();
}

function ensureHotkeyValue(save = false) {
    const hotkeyInputEl = document.getElementById('hotkey');
    if (!hotkeyInputEl) return lastHotkeyValue;
    let next = (hotkeyInputEl.value || '').trim();
    if (!next) {
        next = lastHotkeyValue || 'Alt+A';
        hotkeyInputEl.value = next;
    }
    lastHotkeyValue = next;
    if (save) saveDefaults(['speech-triggers']);
    return next;
}

// Backend indicator helpers
function setBackendIndicator(backend) {
    const root = document.getElementById('backend-indicator');
    const valueEl = document.getElementById('backend-value');
    const chipEl = document.getElementById('backend-chip');
    const chipText = document.getElementById('backend-chip-text');
    const hintEl = document.getElementById('backend-hint');

    if (!root || !valueEl || !chipEl || !chipText || !hintEl) return;

    const b = (backend || '').toLowerCase();

    valueEl.textContent = t('backend_indicator_value_active', 'Active');

    if (b === 'webgpu') {
        root.classList.remove('warn');
        root.classList.add('good');

        chipText.textContent = t('backend_chip_webgpu', 'WebGPU');
        chipEl.style.color = 'var(--backend-good-text)';
        hintEl.textContent = t('backend_hint_webgpu', 'GPU accelerated (best performance when supported).');
        return;
    }

    if (b === 'wasm') {
        root.classList.remove('good');
        root.classList.add('warn');

        chipText.textContent = t('backend_chip_wasm', 'WASM');
        chipEl.style.color = '#8b5cf6';
        hintEl.textContent = t('backend_hint_wasm', 'CPU fallback (WebGPU unsupported or failed to initialize).');
        return;
    }

    root.classList.remove('good');
    root.classList.add('warn');

    valueEl.textContent = t('backend_indicator_value_unknown', 'Unknown');
    chipText.textContent = t('backend_chip_unknown', 'Unknown');
    chipEl.style.color = 'var(--backend-warn-text)';
    hintEl.textContent = t(
        'backend_hint_unknown',
        'Backend will be detected after the first local transcription/model load.'
    );
}

async function refreshBackendIndicator() {
    try {
        const resp = await browser.runtime.sendMessage({ type: 'ASR_BACKEND_PING' });

        const preferred = (resp?.preferredBackend || '').toLowerCase();
        const active = (resp?.backend || '').toLowerCase();
        const hasModelLoaded = !!resp?.hasModelLoaded;
        const w = resp?.webgpu;

        const webgpuUsable = !!(w && w.hasNavigatorGpu && w.adapterOk && w.deviceOk);

        if (hasModelLoaded && (active === 'webgpu' || active === 'wasm')) {
            setBackendIndicator(active);
            return;
        }

        if (preferred === 'webgpu' && webgpuUsable) {
            setBackendIndicator('webgpu');
            const hintEl = document.getElementById('backend-hint');
            if (hintEl) hintEl.textContent = t(
                'backend_hint_webgpu_enabled_supported',
                'WebGPU is enabled and supported. It will activate after the next local model load/transcription.'
            );
            return;
        }

        setBackendIndicator('wasm');
        const hintEl2 = document.getElementById('backend-hint');
        if (hintEl2) {
            if (preferred === 'wasm') {
                hintEl2.textContent = t('backend_hint_preferred_wasm', 'WASM is selected as the preferred backend.');
            } else if (w && w.hasNavigatorGpu && (!w.adapterOk || !w.deviceOk)) {
                hintEl2.textContent =
                    `${t('backend_hint_webgpu_init_failed_prefix', 'WebGPU API exists, but adapter/device init failed:')} ` +
                    `${w.error || t('backend_unknown_error', 'unknown error')}`;
            } else if (w && !w.hasNavigatorGpu) {
                hintEl2.textContent = t('backend_hint_webgpu_unavailable', 'WebGPU is not available in this context; using WASM.');
            } else {
                hintEl2.textContent = t('backend_hint_using_wasm', 'Using WASM.');
            }
        }
    } catch (_) {
        setBackendIndicator('unknown');
    }
}

async function saveDefaults(statusKeys = []) {
    if (isApplyingExternalUpdate) return;

    const model = document.getElementById('model-select')?.value || 'Xenova/whisper-base';
    const voskModelInputValue = (document.getElementById('vosk-model-input')?.value || '').trim();
    const language = document.getElementById('language-select')?.value || 'auto';
    const silenceTimeout = clampTimeout(document.getElementById('silence-timeout')?.value) ?? 1500;
    const provider = normalizeProvider(document.getElementById('provider-select')?.value);
    const assemblyaiApiKey = (document.getElementById('assemblyai-key')?.value || '').trim();
    const disableFavicons = document.getElementById('disable-favicons')?.checked === true;

    const micGain = clampMicGain(document.getElementById('mic-gain')?.value);
    const silenceSensitivity = clampSilenceSensitivity(document.getElementById('silence-sensitivity')?.value);

    const showModelSections = document.getElementById('show-model-sections-toggle')?.checked === true;
    const hideModelSections = !showModelSections;

    const enableHardCap = document.getElementById('enable-hardcap')?.checked === true;
    const disableHardCap = !enableHardCap;

    const cacheDefaultModel = document.getElementById('cache-default-model')?.checked === true;

    const stripTrailingPeriod = document.getElementById('strip-trailing-period')?.checked !== true;
    const disableSpaceNormalization = document.getElementById('disable-space-normalization')?.checked === true;

    const assemblyaiStreamingEnabled = document.getElementById('assemblyai-streaming')?.checked !== true;
    const assemblyaiStreamingMultilingualEnabled =
        document.getElementById('assemblyai-streaming-multilingual')?.checked !== true;

    const streamingSilenceAlways = document.getElementById('assemblyai-streaming-silence-always')?.checked === true;
    const streamingSilenceNever = document.getElementById('assemblyai-streaming-silence-never')?.checked === true;
    const streamingSilencePartial = document.getElementById('assemblyai-streaming-silence-partial')?.checked === true;
    const assemblyaiStreamingSilenceMode = streamingSilenceNever
        ? 'never'
        : (streamingSilenceAlways ? 'always' : (streamingSilencePartial ? 'partial' : 'never'));

    const enableShortcut = document.getElementById('enable-shortcut')?.checked !== true;
    const sendEnterAfter = document.getElementById('send-enter-after')?.checked === true;

    const toastNotificationsEnabled = document.getElementById('toast-notifications')?.checked === true;
    const hideWarningBanner = document.getElementById('hide-warning-banner')?.checked === true;

    let hotkey = (document.getElementById('hotkey')?.value || '').trim();
    if (!hotkey) {
        hotkey = lastHotkeyValue || 'Alt+A';
        const hk = document.getElementById('hotkey');
        if (hk) hk.value = hotkey;
    }

    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    const previousVoskModel = settings?.defaults?.voskModel || DEFAULT_VOSK_MODEL;

    const voskModel = normalizeVoskModel(voskModelInputValue, previousVoskModel);

    settings.defaults = {
        model,
        voskModel,
        language,
        silenceTimeoutMs: silenceTimeout,
        provider,
        micGain,
        silenceSensitivity
    };

    if (typeof settings.graceEnabled === 'undefined') settings.graceEnabled = true;
    if (typeof settings.graceMs === 'undefined') settings.graceMs = 450;

    settings.assemblyaiApiKey = assemblyaiApiKey || null;
    settings.disableFavicons = disableFavicons;
    settings.hideModelSections = hideModelSections;

    settings.disableHardCap = disableHardCap;
    settings.cacheDefaultModel = cacheDefaultModel;
    settings.stripTrailingPeriod = stripTrailingPeriod;
    settings.disableSpaceNormalization = disableSpaceNormalization;
    settings.assemblyaiStreamingEnabled = assemblyaiStreamingEnabled;
    settings.assemblyaiStreamingMultilingualEnabled = assemblyaiStreamingMultilingualEnabled;
    settings.assemblyaiStreamingSilenceMode = assemblyaiStreamingSilenceMode;

    settings.shortcutEnabled = enableShortcut;
    settings.hotkey = hotkey;
    settings.sendEnterAfterResult = sendEnterAfter;
    lastHotkeyValue = hotkey;

    settings.toastNotificationsEnabled = toastNotificationsEnabled;
    settings.hideWarningBanner = hideWarningBanner;

    await browser.storage.local.set({ settings });
    await broadcastConfigChanged();
    statusKeys.forEach(k => showSaved(k));
}

async function saveDebugMode(statusKeys = []) {
    if (isRestoring || isApplyingExternalUpdate) return;
    const debugMode = document.getElementById('debug-mode')?.checked === true;
    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    settings.debugMode = debugMode;
    await browser.storage.local.set({ settings });
    await broadcastConfigChanged();
    statusKeys.forEach(k => showSaved(k));
}

async function saveGraceSetting(statusKeys = []) {
    if (isRestoring || isApplyingExternalUpdate) return;
    const disableGrace = document.getElementById('disable-grace-window')?.checked === true;
    const graceMs = clampGrace(document.getElementById('grace-ms')?.value);
    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    settings.graceEnabled = !disableGrace;
    settings.graceMs = graceMs;
    await browser.storage.local.set({ settings });
    await broadcastConfigChanged();
    statusKeys.forEach(k => showSaved(k));
}

// Replace existing addOrUpdateOverride() with this version
async function addOrUpdateOverride() {
    const hostEl = document.getElementById('override-host');
    const host = normalizeHost(hostEl?.value);
    if (!host) return;

    const modelEl = document.getElementById('override-model');
    const voskModelEl = document.getElementById('override-vosk-model');
    const langEl = document.getElementById('override-language');
    const timeoutEl = document.getElementById('override-timeout');
    const providerEl = document.getElementById('override-provider');
    const statusEl = document.getElementById('override-status');
    const graceEl = document.getElementById('override-grace');

    // Read the visible value from the Vosk override input (this can be a pretty name or an id)
    const voskModelRaw = (voskModelEl?.value || '').trim();

    // If user selected/typed the pretty display name, map it back to the canonical id
    const mappedVoskModel = (voskModelRaw && window.VOSK_PRETTY_TO_ID && window.VOSK_PRETTY_TO_ID.has(voskModelRaw))
        ? window.VOSK_PRETTY_TO_ID.get(voskModelRaw)
        : voskModelRaw;

    // Final model: prefer a Vosk selection, otherwise the whisper override select
    const model = mappedVoskModel || (modelEl?.value || null);

    // --- Prevent saving extremely large Vosk models if we have metadata for them ---
    if (mappedVoskModel) {
        const meta = voskModelIndex.get(mappedVoskModel);
        if (meta?.size != null) {
            const mb = sizeToMb(meta.size);
            if (mb != null && mb > 1024) {
                alert(`Selected Vosk model (${mappedVoskModel}) is ${Math.round(mb)} MB which exceeds the 1024 MB limit. Please choose a smaller model.`);
                return;
            }
        }
        // If no metadata available, allow saving (background will validate if possible)
    }

    const language = langEl?.value || null;
    const silenceTimeout = clampTimeout(timeoutEl?.value);
    let provider = providerEl?.value || null;
    const graceMs = parseGraceOverride(graceEl?.value);

    // Infer provider from model if provider not explicitly set
    if (!provider && model) {
        provider = model.startsWith('vosk-model-') ? 'vosk' : 'local-whisper';
    }

    const siteStatus = (statusEl?.value || '').trim();
    const enabled = (siteStatus !== 'disabled');

    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    settings.overrides = settings.overrides || {};

    settings.overrides[host] = {
        ...(model ? { model } : {}),
        ...(language ? { language } : {}),
        ...(silenceTimeout ? { silenceTimeoutMs: silenceTimeout } : {}),
        ...(provider ? { provider: normalizeProvider(provider) } : {}),
        ...(typeof graceMs === 'number' ? { graceMs } : {}),
        ...(enabled ? {} : { enabled: false })
    };

    await browser.storage.local.set({ settings });

    selectedOverrideHost = host;

    renderOverrides(settings.overrides, settings.disableFavicons !== true);

    // Clear inputs (visible ones)
    hostEl.value = '';
    if (timeoutEl) timeoutEl.value = '';
    if (graceEl) graceEl.value = '';
    if (modelEl) modelEl.value = '';
    if (voskModelEl) voskModelEl.value = '';
    if (langEl) langEl.value = '';
    if (providerEl) providerEl.value = '';
    if (statusEl) statusEl.value = '';

    // If there is a pretty display input associated with the main vosk control, keep it cleared too.
    try {
        const prettyMain = document.getElementById('vosk-model-pretty-display');
        if (prettyMain) prettyMain.value = '';
    } catch (_) {}

    showSaved('overrides');
    await broadcastConfigChanged();
}

async function removeAllOverrides() {
    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    settings.overrides = {};
    await browser.storage.local.set({ settings });

    selectedOverrideHost = null;
    renderOverrides(settings.overrides, settings.disableFavicons !== true);

    showSaved('overrides');
    await broadcastConfigChanged();
}

async function removeSingleOverride(host) {
    if (!host) return;
    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    if (settings.overrides && settings.overrides[host]) {
        delete settings.overrides[host];
        await browser.storage.local.set({ settings });

        if (selectedOverrideHost === host) selectedOverrideHost = null;
        renderOverrides(settings.overrides, settings.disableFavicons !== true);

        showSaved('overrides');
        await broadcastConfigChanged();
    }
}

function setOverridesCount(n) {
    const el = document.getElementById('overrides-count');
    if (!el) return;
    el.textContent = `(${n || 0})`;
}

function renderOverrides(overrides, showFavicons) {
    const tbody = document.querySelector('#override-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!overrides) { setOverridesCount(0); return; }

    const entries = Object.entries(overrides).sort((a, b) => a[0].localeCompare(b[0]));
    setOverridesCount(entries.length);

    for (const [host, cfg] of entries) {
        const tr = document.createElement('tr');
        tr.dataset.host = host;

        if (selectedOverrideHost && selectedOverrideHost === host) {
            tr.classList.add('selected');
        }

        const enabled = cfg?.enabled !== false;

        // Host cell with optional favicon (no inline onerror)
        const tdHost = document.createElement('td');
        const hostSpan = document.createElement('span');
        hostSpan.className = 'host-cell';
        if (showFavicons) {
            const img = document.createElement('img');
            img.className = 'fav-icon';
            img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
            // Attach error handler programmatically to comply with CSP
            img.addEventListener('error', () => { img.style.display = 'none'; });
            hostSpan.appendChild(img);
        }
        hostSpan.appendChild(document.createTextNode(host));
        tdHost.appendChild(hostSpan);
        tr.appendChild(tdHost);

        // Helper to create td cells
        const makeTd = (content) => {
            const td = document.createElement('td');
            td.textContent = (content === undefined || content === null || content === '') ? '—' : String(content);
            return td;
        };

        tr.appendChild(makeTd(enabled ? 'Yes' : 'No'));
        tr.appendChild(makeTd(cfg.model || '—'));
        tr.appendChild(makeTd(cfg.language || '—'));
        tr.appendChild(makeTd(cfg.silenceTimeoutMs ?? '—'));
        tr.appendChild(makeTd(cfg.graceMs ?? '—'));
        tr.appendChild(makeTd(cfg.provider || '—'));

        // Remove button
        const tdRemove = document.createElement('td');
        tdRemove.style.textAlign = 'right';
        const rmBtn = document.createElement('button');
        rmBtn.className = 'row-delete';
        rmBtn.setAttribute('data-host', host);
        rmBtn.setAttribute('aria-label', `Remove ${host}`);
        rmBtn.textContent = '✖';
        tdRemove.appendChild(rmBtn);
        tr.appendChild(tdRemove);

        tbody.appendChild(tr);
    }
}

// delete button stays working; stopPropagation so row click doesn’t also load it
document.querySelector('#override-table tbody')?.addEventListener('click', (e) => {
    const del = e.target.closest('.row-delete');
    if (del) {
        e.stopPropagation();
        const host = del.getAttribute('data-host');
        removeSingleOverride(host);
        return;
    }
});

function toggleFavicons(statusKeys = []) {
    if (isRestoring) return;
    saveDefaults(statusKeys);
}

// factory reset: clear storage and force UI to reflect defaults immediately
async function factoryReset() {
    try {
        // mark restoring so storage.onChanged handlers don't fight our update
        isRestoring = true;

        // Clear settings
        await browser.storage.local.set({ settings: {} });
        await browser.storage.local.remove('settings');

        // Visual 'saved' feedback and notify other parts of the extension
        showSaved('save');
        await broadcastConfigChanged();

        // Re-read settings (should be empty) and apply defaults to UI
        await restoreOptions();

        // Ensure Vosk pretty-display (if present) is synchronized with backing input:
        try {
            const voskBacking = document.getElementById('vosk-model-input') || document.getElementById('vosk-model');
            const voskPretty = document.getElementById('vosk-model-pretty-display');
            if (voskBacking && voskPretty) {
                const pretty = window.VOSK_ID_TO_PRETTY?.get(voskBacking.value) || voskBacking.value || '';
                voskPretty.value = pretty;
            }
        } catch (_) { /* ignore if not present */ }

        // Force model-select to run its change handlers so the visual label updates
        try {
            const modelSelect = document.getElementById('model-select');
            if (modelSelect) {
                // trigger change so any size warnings / other UI updates run
                modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (_) { }

        // Re-run helpers to ensure all UI pieces are up-to-date
        try { checkModelSize(); } catch (_) { }
        try { checkVoskModelSize(); } catch (_) { }
        try { applyVisibility(); } catch (_) { }
    } finally {
        // leave restoring mode
        isRestoring = false;
    }
}

async function restoreOptions() {
    isRestoring = true;
    hideAllStatusBadges();

    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    const d = settings.defaults || {};

    document.getElementById('model-select').value = d.model || 'Xenova/whisper-base';
    document.getElementById('vosk-model-input').value = normalizeVoskModel(d.voskModel || DEFAULT_VOSK_MODEL);
    document.getElementById('language-select').value = d.language || 'auto';
    document.getElementById('silence-timeout').value = d.silenceTimeoutMs || 1500;
    document.getElementById('provider-select').value = normalizeProvider(d.provider || 'vosk');
    document.getElementById('assemblyai-key').value = settings.assemblyaiApiKey || '';

    const micGain = clampMicGain(
        d.micGain ?? (settings.boostMicGain === true ? 1.8 : MIC_GAIN_DEFAULT)
    );
    document.getElementById('mic-gain').value = micGain;

    const silenceSensitivity = clampSilenceSensitivity(d.silenceSensitivity ?? SILENCE_SENSITIVITY_DEFAULT);
    document.getElementById('silence-sensitivity').value = silenceSensitivity;

    updateMicGainDisplay();
    updateSilenceSensitivityDisplay();

    document.getElementById('debug-mode').checked = settings.debugMode === true;

    const toastToggle = document.getElementById('toast-notifications');
    if (toastToggle) toastToggle.checked = settings.toastNotificationsEnabled === true;

    const hideBannerToggle = document.getElementById('hide-warning-banner');
    if (hideBannerToggle) hideBannerToggle.checked = settings.hideWarningBanner === true;
    applyBannerVisibility(settings.hideWarningBanner === true);

    const graceMs = typeof settings.graceMs === 'number' ? settings.graceMs : 450;
    document.getElementById('grace-ms').value = graceMs;

    const disableFavicons = settings.disableFavicons === true;
    document.getElementById('disable-favicons').checked = disableFavicons;

    const hideModelSections = settings.hideModelSections !== false;
    document.getElementById('show-model-sections-toggle').checked = !hideModelSections;

    const disableHardCap = settings.disableHardCap !== false;
    document.getElementById('enable-hardcap').checked = !disableHardCap;

    const disableGraceWindow = settings.graceEnabled === false;
    const graceToggle = document.getElementById('disable-grace-window');
    if (graceToggle) graceToggle.checked = disableGraceWindow;

    const cacheDefaultModel = settings.cacheDefaultModel === true;
    const cacheToggle = document.getElementById('cache-default-model');
    if (cacheToggle) cacheToggle.checked = cacheDefaultModel;

    const stripTrailing = settings.stripTrailingPeriod !== false;
    const stripToggle = document.getElementById('strip-trailing-period');
    if (stripToggle) stripToggle.checked = !stripTrailing;

    const disableSpaceNormalization = settings.disableSpaceNormalization === true;
    const disableSpaceToggle = document.getElementById('disable-space-normalization');
    if (disableSpaceToggle) disableSpaceToggle.checked = disableSpaceNormalization;

    const assemblyStreamingToggle = document.getElementById('assemblyai-streaming');
    if (assemblyStreamingToggle) assemblyStreamingToggle.checked = settings.assemblyaiStreamingEnabled === false;

    const assemblyStreamingMultiToggle = document.getElementById('assemblyai-streaming-multilingual');
    if (assemblyStreamingMultiToggle) {
        assemblyStreamingMultiToggle.checked = settings.assemblyaiStreamingMultilingualEnabled === false;
    }

    const silenceMode = settings.assemblyaiStreamingSilenceMode || 'never';
    const silenceAlwaysEl = document.getElementById('assemblyai-streaming-silence-always');
    const silenceNeverEl = document.getElementById('assemblyai-streaming-silence-never');
    const silencePartialEl = document.getElementById('assemblyai-streaming-silence-partial');
    if (silenceAlwaysEl) silenceAlwaysEl.checked = silenceMode === 'always';
    if (silenceNeverEl) silenceNeverEl.checked = silenceMode === 'never';
    if (silencePartialEl) silencePartialEl.checked = silenceMode === 'partial';

    const enableShortcut = settings.shortcutEnabled !== false;
    const sendEnterAfter = settings.sendEnterAfterResult === true;
    const hkVal = typeof settings.hotkey === 'string' ? settings.hotkey : 'Alt+A';

    const hotkeyInput = document.getElementById('hotkey');
    const enableChk = document.getElementById('enable-shortcut');
    const sendEnterChk = document.getElementById('send-enter-after');

    if (enableChk) enableChk.checked = !enableShortcut;
    if (sendEnterChk) sendEnterChk.checked = sendEnterAfter;
    if (hotkeyInput) hotkeyInput.value = hkVal;
    lastHotkeyValue = hkVal || 'Alt+A';

    checkModelSize();
    checkVoskModelSize();

    renderOverrides(settings.overrides || {}, settings.disableFavicons !== true);
    applyVisibility();

    applyOverridesListOpenState();

    refreshBackendIndicator().catch(() => { });

    isRestoring = false;
}

document.getElementById('model-select')?.addEventListener('change', () => {
    if (!isRestoring) {
        checkModelSize();
        saveDefaults(['local']);
    }
});
document.getElementById('language-select')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['local']); });
document.getElementById('silence-timeout')?.addEventListener('input', () => {
    if (!isRestoring) saveDefaults(['speech-logic']);
});
document.getElementById('assemblyai-key')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['cloud']); });

function showSaved(area = 'save') {
    const map = {
        'engine': 'status-engine',
        'local': 'status-local',
        'vosk': 'status-vosk',
        'cloud': 'status-cloud',
        'dev': 'status-dev',
        'overrides': 'status-overrides',
        'speech-triggers': 'status-speech-triggers',
        'speech-logic': 'status-speech-logic',
        'save': 'status-save'
    };
    const id = map[area] || 'status-save';
    const el = document.getElementById(id);
    if (!el) return;

    if (statusTimers.has(id)) clearTimeout(statusTimers.get(id));
    el.classList.remove('saved-pulse');
    void el.offsetWidth;
    el.classList.add('saved-pulse');
    el.style.opacity = '1';

    const timer = setTimeout(() => {
        el.style.opacity = '0';
        el.classList.remove('saved-pulse');
    }, 1200);
    statusTimers.set(id, timer);
}

function applyOverridesListOpenState() {
    const body = document.getElementById('overrides-list-body');
    const btn = document.getElementById('toggle-overrides-list');
    if (!body || !btn) return;

    body.classList.toggle('open', overridesListOpen);
    btn.textContent = overridesListOpen
        ? t('hide', 'Hide')
        : t('show', 'Show');
}

function installOverridesListToggle() {
    const btn = document.getElementById('toggle-overrides-list');
    if (!btn) return;
    btn.addEventListener('click', () => {
        overridesListOpen = !overridesListOpen;
        applyOverridesListOpenState();
    });

    overridesListOpen = true;
    applyOverridesListOpenState();
}

// Replace existing loadOverrideIntoInputs(...) with this version
function loadOverrideIntoInputs(host, cfg) {
    const hostEl = document.getElementById('override-host');
    const modelEl = document.getElementById('override-model');
    const voskModelEl = document.getElementById('override-vosk-model');
    const langEl = document.getElementById('override-language');
    const timeoutEl = document.getElementById('override-timeout');
    const providerEl = document.getElementById('override-provider');
    const statusEl = document.getElementById('override-status');
    const graceEl = document.getElementById('override-grace');

    if (hostEl) hostEl.value = host || '';

    // If the override model is a Vosk id, show the pretty name in the visible override input (if we know it).
    if (cfg?.model && cfg.model.startsWith('vosk-model-')) {
        const pretty = window.VOSK_ID_TO_PRETTY?.get(cfg.model) || cfg.model;
        if (voskModelEl) voskModelEl.value = pretty;
        if (modelEl) modelEl.value = '';
    } else {
        if (modelEl) modelEl.value = cfg?.model || '';
        if (voskModelEl) voskModelEl.value = '';
    }

    if (langEl) langEl.value = (cfg?.language ?? '');
    if (timeoutEl) timeoutEl.value = (typeof cfg?.silenceTimeoutMs === 'number') ? String(cfg.silenceTimeoutMs) : '';
    if (providerEl) providerEl.value = cfg?.provider || '';
    if (statusEl) statusEl.value = (cfg?.enabled === false) ? 'disabled' : '';
    if (graceEl) graceEl.value = (typeof cfg?.graceMs === 'number') ? String(cfg.graceMs) : '';
}

function clearOverrideInputs() {
    const hostEl = document.getElementById('override-host');
    const modelEl = document.getElementById('override-model');
    const voskModelEl = document.getElementById('override-vosk-model');
    const langEl = document.getElementById('override-language');
    const timeoutEl = document.getElementById('override-timeout');
    const providerEl = document.getElementById('override-provider');
    const statusEl = document.getElementById('override-status');
    const graceEl = document.getElementById('override-grace');

    if (hostEl) hostEl.value = '';
    if (modelEl) modelEl.value = '';
    if (voskModelEl) voskModelEl.value = '';
    if (langEl) langEl.value = '';
    if (timeoutEl) timeoutEl.value = '';
    if (providerEl) providerEl.value = '';
    if (statusEl) statusEl.value = '';
    if (graceEl) graceEl.value = '';

    selectedOverrideHost = null;

    browser.storage.local.get('settings').then(({ settings }) => {
        renderOverrides(settings?.overrides || {}, settings?.disableFavicons !== true);
    }).catch(() => { });
}

function installOverrideRowClickToLoad() {
    const tbody = document.querySelector('#override-table tbody');
    if (!tbody) return;

    tbody.addEventListener('click', async (e) => {
        if (e.target.closest('.row-delete')) return;

        const row = e.target.closest('tr');
        const host = row?.dataset?.host;
        if (!host) return;

        const { settings } = await browser.storage.local.get('settings');
        const cfg = settings?.overrides?.[host] || {};

        selectedOverrideHost = host;
        loadOverrideIntoInputs(host, cfg);

        renderOverrides(settings?.overrides || {}, settings?.disableFavicons !== true);
    });
}

function installLiveSettingsListener() {
    try {
        browser.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local') return;
            if (!changes.settings) return;

            const next = changes.settings.newValue || {};
            if (isRestoring) return;

            const hotkeyEl = document.getElementById('hotkey');
            const isEditingHotkey = capturingHotkey || (document.activeElement === hotkeyEl);

            isApplyingExternalUpdate = true;
            try {
                renderOverrides(next.overrides || {}, next.disableFavicons !== true);

                const hideModelSections = next.hideModelSections !== false;
                const showToggle = document.getElementById('show-model-sections-toggle');
                if (showToggle) showToggle.checked = !hideModelSections;

                const providerSelect = document.getElementById('provider-select');
                const nextProvider = normalizeProvider(next?.defaults?.provider || 'vosk');
                if (providerSelect && providerSelect.value !== nextProvider) providerSelect.value = nextProvider;
                applyVisibility();

                const favToggle = document.getElementById('disable-favicons');
                if (favToggle) favToggle.checked = next.disableFavicons === true;

                const stripToggle = document.getElementById('strip-trailing-period');
                if (stripToggle) stripToggle.checked = next.stripTrailingPeriod === false;

                const disableSpaceToggle = document.getElementById('disable-space-normalization');
                if (disableSpaceToggle) disableSpaceToggle.checked = next.disableSpaceNormalization === true;

                const assemblyStreamingToggle = document.getElementById('assemblyai-streaming');
                if (assemblyStreamingToggle) assemblyStreamingToggle.checked = next.assemblyaiStreamingEnabled === false;

                const assemblyStreamingMultiToggle = document.getElementById('assemblyai-streaming-multilingual');
                if (assemblyStreamingMultiToggle) {
                    assemblyStreamingMultiToggle.checked = next.assemblyaiStreamingMultilingualEnabled === false;
                }

                const silenceMode = next.assemblyaiStreamingSilenceMode || 'never';
                const silenceAlwaysEl = document.getElementById('assemblyai-streaming-silence-always');
                const silenceNeverEl = document.getElementById('assemblyai-streaming-silence-never');
                const silencePartialEl = document.getElementById('assemblyai-streaming-silence-partial');
                if (silenceAlwaysEl) silenceAlwaysEl.checked = silenceMode === 'always';
                if (silenceNeverEl) silenceNeverEl.checked = silenceMode === 'never';
                if (silencePartialEl) silencePartialEl.checked = silenceMode === 'partial';

                const d = next.defaults || {};
                const modelEl = document.getElementById('model-select');
                const voskModelEl = document.getElementById('vosk-model-input');
                const langEl = document.getElementById('language-select');
                const silenceEl = document.getElementById('silence-timeout');
                if (modelEl && d.model && modelEl.value !== d.model) modelEl.value = d.model;
                if (voskModelEl) voskModelEl.value = normalizeVoskModel(d.voskModel || DEFAULT_VOSK_MODEL);
                if (langEl && d.language && langEl.value !== d.language) langEl.value = d.language;
                if (silenceEl && typeof d.silenceTimeoutMs === 'number' && String(silenceEl.value) !== String(d.silenceTimeoutMs)) {
                    silenceEl.value = d.silenceTimeoutMs;
                }

                const micGainEl = document.getElementById('mic-gain');
                const nextMicGain = clampMicGain(
                    next?.defaults?.micGain ?? (next?.boostMicGain === true ? 1.8 : MIC_GAIN_DEFAULT)
                );
                if (micGainEl && Number(micGainEl.value) !== nextMicGain) micGainEl.value = nextMicGain;
                updateMicGainDisplay();

                const sensEl = document.getElementById('silence-sensitivity');
                const nextSens = clampSilenceSensitivity(next?.defaults?.silenceSensitivity ?? SILENCE_SENSITIVITY_DEFAULT);
                if (sensEl && Number(sensEl.value) !== nextSens) sensEl.value = nextSens;
                updateSilenceSensitivityDisplay();

                const debugEl = document.getElementById('debug-mode');
                if (debugEl) debugEl.checked = next.debugMode === true;

                const toastEl = document.getElementById('toast-notifications');
                if (toastEl) toastEl.checked = next.toastNotificationsEnabled === true;

                const hideBannerEl = document.getElementById('hide-warning-banner');
                if (hideBannerEl) hideBannerEl.checked = next.hideWarningBanner === true;
                applyBannerVisibility(next.hideWarningBanner === true);

                const enableHardcapEl = document.getElementById('enable-hardcap');
                if (enableHardcapEl) {
                    const disableHardCap = next.disableHardCap !== false;
                    enableHardcapEl.checked = !disableHardCap;
                }

                const cacheEl = document.getElementById('cache-default-model');
                if (cacheEl) cacheEl.checked = next.cacheDefaultModel === true;

                const graceMsEl = document.getElementById('grace-ms');
                if (graceMsEl) graceMsEl.value = (typeof next.graceMs === 'number') ? next.graceMs : 450;

                const disableGraceEl = document.getElementById('disable-grace-window');
                if (disableGraceEl) disableGraceEl.checked = next.graceEnabled === false;

                const enableShortcutEl = document.getElementById('enable-shortcut');
                if (enableShortcutEl) enableShortcutEl.checked = next.shortcutEnabled === false;

                const sendEnterEl = document.getElementById('send-enter-after');
                if (sendEnterEl) sendEnterEl.checked = next.sendEnterAfterResult === true;

                if (!isEditingHotkey) {
                    const hk = typeof next.hotkey === 'string' ? next.hotkey : 'Alt+A';
                    if (hotkeyEl && hotkeyEl.value !== hk) hotkeyEl.value = hk;
                    lastHotkeyValue = hk || 'Alt+A';
                }

                const keyEl = document.getElementById('assemblyai-key');
                const nextKey = next.assemblyaiApiKey || '';
                if (keyEl && keyEl.value !== nextKey) keyEl.value = nextKey;

                checkModelSize();
                checkVoskModelSize();

                refreshBackendIndicator().catch(() => { });
            } finally {
                isApplyingExternalUpdate = false;
            }
        });
    } catch (_) { }
}

async function exportSettingsToFile() {
    try {
        const stored = await browser.storage.local.get('settings');
        const settings = stored.settings || {};
        const payload = { version: browser.runtime.getManifest().version, exportedAt: new Date().toISOString(), settings };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `whisper-settings-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        showSaved('save');
    } catch (e) {
        console.error('Export failed', e);
        alert('Export failed: ' + (e?.message || e));
    }
}

async function importSettingsFromFile(e) {
    const input = e?.target;
    const file = input?.files?.[0];
    if (!file) return;

    try {
        const text = await file.text();
        const parsed = JSON.parse(text);

        const incomingSettings = parsed?.settings && typeof parsed.settings === 'object'
            ? parsed.settings
            : (parsed && typeof parsed === 'object' ? parsed : null);

        if (!incomingSettings || typeof incomingSettings !== 'object') {
            throw new Error('No settings found in file.');
        }

        if (incomingSettings.defaults) {
            const p = incomingSettings.defaults.provider;
            if (p && !ALLOWED_PROVIDERS.includes(p)) incomingSettings.defaults.provider = 'vosk';
        }

        await browser.storage.local.set({ settings: incomingSettings });
        await broadcastConfigChanged();
        await restoreOptions();
        showSaved('save');
    } catch (err) {
        console.error('Import failed', err);
        alert('Import failed: ' + (err?.message || err));
    } finally {
        try { input.value = ''; } catch (_) { }
    }
}

// background.js

browser.runtime.onSuspend.addListener(() => {
  console.log('[BG] Extension suspending/reloading. Forcing deep clean...');
  
  // 1. Kill the Whisper worker immediately
  if (asrWorker) {
    asrWorker.terminate();
    asrWorker = null;
  }

  // 2. Kill all Vosk models
  for (const [id, entry] of voskModels.entries()) {
    if (entry.model) {
      try { entry.model.terminate(); } catch(e) {}
    }
  }
  voskModels.clear();
  voskRecognizers.clear();
});