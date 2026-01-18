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
const ALLOWED_PROVIDERS = ['local-whisper', 'assemblyai'];

let isRestoring = false;
let capturingHotkey = false;
let lastHotkeyValue = 'Alt+A';
const statusTimers = new Map();

// NEW: notify all open tabs so content scripts update immediately (no reload)
async function broadcastConfigChanged() {
    try {
        // background listeners (prefetch, etc.)
        try { browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' }); } catch (_) { }

        // content scripts in tabs
        const tabs = await browser.tabs.query({});
        await Promise.allSettled(
            tabs
                .filter(t => typeof t.id === 'number')
                .map(t => browser.tabs.sendMessage(t.id, { type: 'CONFIG_CHANGED' }))
        );
    } catch (_) {
        // ignore
    }
}

document.addEventListener('DOMContentLoaded', () => {
    applyI18n();
    restoreOptions();
});

document.getElementById('save-btn-bottom').addEventListener('click', () => saveDefaults(['save']));
document.getElementById('open-assemblyai').addEventListener('click', () => {
    browser.tabs.create({ url: 'https://www.assemblyai.com/dashboard/api-keys', active: true });
});
document.getElementById('add-override').addEventListener('click', addOrUpdateOverride);
document.getElementById('remove-override').addEventListener('click', removeAllOverrides);
document.getElementById('debug-mode').addEventListener('change', () => saveDebugMode(['dev']));
document.getElementById('grace-ms').addEventListener('change', () => saveGraceSetting(['local']));
document.getElementById('factory-reset').addEventListener('click', factoryReset);
document.getElementById('disable-favicons').addEventListener('change', () => toggleFavicons(['dev']));
document.getElementById('show-model-sections-toggle').addEventListener('change', () => { if (!isRestoring) saveDefaults(['dev']); applyVisibility(); });
document.getElementById('provider-select').addEventListener('change', () => { if (!isRestoring) saveDefaults(['engine']); applyVisibility(); });
document.getElementById('enable-hardcap')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['dev']); });
document.getElementById('disable-grace-window')?.addEventListener('change', () => { if (!isRestoring) saveGraceSetting(['dev']); });
document.getElementById('cache-default-model')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['dev']); });
document.getElementById('enable-shortcut')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['speech']); });
document.getElementById('send-enter-after')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['speech']); });

const hotkeyInput = document.getElementById('hotkey');
if (hotkeyInput) {
    hotkeyInput.addEventListener('focus', () => {
        capturingHotkey = true;
        hotkeyInput.value = '';
    });
    hotkeyInput.addEventListener('blur', () => {
        capturingHotkey = false;
        ensureHotkeyValue(true); // enforce fallback + save on blur
    });
    hotkeyInput.addEventListener('keydown', (e) => {
        if (!capturingHotkey) return;
        e.preventDefault();

        // Clear -> revert to last or default and save
        if (e.key === 'Backspace' || e.key === 'Delete') {
            ensureHotkeyValue(true);
            capturingHotkey = false;
            hotkeyInput.blur();
            return;
        }
        // Cancel and disable, but keep a visible hotkey value
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
        if (enableChk) enableChk.checked = true;
        hotkeyInput.blur();
        saveDefaults(['speech']);
    });
}

function t(key, fallback = '') {
    return browser.i18n?.getMessage(key) || fallback;
}

function applyI18n() {
    // document title
    const titleMsg = t('options_page_title');
    if (titleMsg) document.title = titleMsg;

    // generic text replacement
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const msg = t(key);
        if (!msg) return;

        const tag = el.tagName;

        if (tag === 'OPTGROUP') { el.label = msg; return; }
        if (tag === 'OPTION') { el.textContent = msg; return; }

        // Allow HTML in banner/notes if provided by message (you already do with banner_text)
        // Only inject HTML if it contains tags; otherwise set textContent.
        if (typeof msg === 'string' && /<\/?[a-z][\s\S]*>/i.test(msg)) {
            el.innerHTML = msg;
        } else if (el.children && el.children.length > 0) {
            // do not clobber nested structure unless message includes HTML
            // (section headers now wrap the label in a <span data-i18n=...>, so safe)
            return;
        } else {
            el.textContent = msg;
        }
    });

    // placeholder support
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

function normalizeProvider(p) {
    return ALLOWED_PROVIDERS.includes(p) ? p : 'local-whisper';
}

function checkModelSize() {
    const model = document.getElementById('model-select').value;
    const warningBox = document.getElementById('size-warning');
    if (!warningBox) return;
    warningBox.style.display = 'none';

    if (model.includes("small") || model.includes("distil-whisper")) {
        warningBox.style.display = 'block';
        warningBox.textContent = t('size_warning', "⚠️ Heavy Model: First run will be slow. If it crashes, use Base or Tiny.");
    }
}

function normalizeHost(host) { return (host || '').trim().toLowerCase(); }

function applyVisibility() {
    const showToggle = document.getElementById('show-model-sections-toggle')?.checked === true;
    const hideModelSections = !showToggle;
    const provider = document.getElementById('provider-select').value || 'local-whisper';
    const cardLocal = document.getElementById('card-local');
    const cardCloud = document.getElementById('card-cloud');
    if (!cardLocal || !cardCloud) return;

    if (!hideModelSections) {
        cardLocal.style.display = '';
        cardCloud.style.display = '';
        return;
    }
    if (provider === 'assemblyai') {
        cardLocal.style.display = 'none';
        cardCloud.style.display = '';
    } else {
        cardLocal.style.display = '';
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
    if (save) saveDefaults(['speech']);
    return next;
}

async function saveDefaults(statusKeys = []) {
    const model = document.getElementById('model-select').value;
    const language = document.getElementById('language-select').value;
    const silenceTimeout = clampTimeout(document.getElementById('silence-timeout').value) || 1500;
    const provider = normalizeProvider(document.getElementById('provider-select').value);
    const assemblyaiApiKey = (document.getElementById('assemblyai-key').value || '').trim();
    const disableFavicons = document.getElementById('disable-favicons').checked;
    const showModelSections = document.getElementById('show-model-sections-toggle').checked === true;
    const hideModelSections = !showModelSections;
    const enableHardCap = document.getElementById('enable-hardcap')?.checked === true;
    const disableHardCap = !enableHardCap;
    const cacheDefaultModel = document.getElementById('cache-default-model')?.checked === true;

    const enableShortcut = document.getElementById('enable-shortcut')?.checked === true;
    const sendEnterAfter = document.getElementById('send-enter-after')?.checked === true;
    let hotkey = (document.getElementById('hotkey')?.value || '').trim();
    if (!hotkey) {
        hotkey = lastHotkeyValue || 'Alt+A';
        const hk = document.getElementById('hotkey');
        if (hk) hk.value = hotkey;
    }

    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    settings.defaults = { model, language, silenceTimeoutMs: silenceTimeout, provider };

    if (typeof settings.graceEnabled === 'undefined') settings.graceEnabled = true;
    if (typeof settings.graceMs === 'undefined') settings.graceMs = 450;

    settings.assemblyaiApiKey = assemblyaiApiKey || null;
    settings.disableFavicons = disableFavicons;
    settings.hideModelSections = hideModelSections;
    settings.disableHardCap = disableHardCap;
    settings.cacheDefaultModel = cacheDefaultModel;

    settings.shortcutEnabled = enableShortcut;
    settings.hotkey = hotkey;
    settings.sendEnterAfterResult = sendEnterAfter;
    lastHotkeyValue = hotkey;

    await browser.storage.local.set({ settings });

    await broadcastConfigChanged();

    statusKeys.forEach(k => showSaved(k));
}

async function saveDebugMode(statusKeys = []) {
    if (isRestoring) return;
    const debugMode = document.getElementById('debug-mode').checked;
    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    settings.debugMode = debugMode;
    await browser.storage.local.set({ settings });
    await broadcastConfigChanged();
    statusKeys.forEach(k => showSaved(k));
}

async function saveGraceSetting(statusKeys = []) {
    if (isRestoring) return;
    const disableGrace = document.getElementById('disable-grace-window')?.checked === true;
    const graceMs = clampGrace(document.getElementById('grace-ms').value);
    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    settings.graceEnabled = !disableGrace;
    settings.graceMs = graceMs;
    await browser.storage.local.set({ settings });
    await broadcastConfigChanged();
    statusKeys.forEach(k => showSaved(k));
}

async function addOrUpdateOverride() {
    const hostEl = document.getElementById('override-host');
    const host = normalizeHost(hostEl.value);
    if (!host) return;

    const modelEl = document.getElementById('override-model');
    const langEl = document.getElementById('override-language');
    const timeoutEl = document.getElementById('override-timeout');
    const providerEl = document.getElementById('override-provider');

    const model = modelEl.value || null;
    const language = langEl.value || null;
    const silenceTimeout = clampTimeout(timeoutEl.value);
    const provider = providerEl.value || null;

    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    settings.overrides = settings.overrides || {};

    settings.overrides[host] = {
        ...(model ? { model } : {}),
        ...(language ? { language } : {}),
        ...(silenceTimeout ? { silenceTimeoutMs: silenceTimeout } : {}),
        ...(provider ? { provider: normalizeProvider(provider) } : {})
    };

    await browser.storage.local.set({ settings });

    renderOverrides(settings.overrides, settings.disableFavicons !== true);
    hostEl.value = '';
    timeoutEl.value = '';
    modelEl.value = '';
    langEl.value = '';
    providerEl.value = '';

    showSaved('overrides');
    await broadcastConfigChanged();
}

async function removeAllOverrides() {
    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    settings.overrides = {};
    await browser.storage.local.set({ settings });

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

        renderOverrides(settings.overrides, settings.disableFavicons !== true);

        showSaved('overrides');
        await broadcastConfigChanged();
    }
}

function renderOverrides(overrides, showFavicons) {
    const tbody = document.querySelector('#override-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!overrides) return;

    Object.entries(overrides).forEach(([host, cfg]) => {
        const favicon = showFavicons
            ? `<img class="fav-icon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32" onerror="this.style.display='none'">`
            : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><span class="host-cell">${favicon}${host}</span></td>
          <td>${cfg.model || '—'}</td>
          <td>${cfg.language || '—'}</td>
          <td>${cfg.silenceTimeoutMs || '—'}</td>
          <td>${cfg.provider || '—'}</td>
          <td style="text-align:right;"><button class="row-delete" data-host="${host}" aria-label="Remove ${host}">✖</button></td>
        `;
        tbody.appendChild(tr);
    });
}

document.querySelector('#override-table tbody')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.row-delete');
    if (!btn) return;
    const host = btn.getAttribute('data-host');
    removeSingleOverride(host);
});

function toggleFavicons(statusKeys = []) {
    if (isRestoring) return;
    saveDefaults(statusKeys);
}

async function factoryReset() {
    await browser.storage.local.set({ settings: {} });
    await browser.storage.local.remove('settings');
    showSaved('save');
    await broadcastConfigChanged();
    await restoreOptions();
}

async function restoreOptions() {
    isRestoring = true;
    hideAllStatusBadges();

    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    const d = settings.defaults || {};

    document.getElementById('model-select').value = d.model || 'Xenova/whisper-tiny';
    document.getElementById('language-select').value = d.language || 'auto';
    document.getElementById('silence-timeout').value = d.silenceTimeoutMs || 1500;
    document.getElementById('provider-select').value = normalizeProvider(d.provider || 'local-whisper');
    document.getElementById('assemblyai-key').value = settings.assemblyaiApiKey || '';

    document.getElementById('debug-mode').checked = settings.debugMode || false;

    const graceMs = typeof settings.graceMs === 'number' ? settings.graceMs : 450;
    document.getElementById('grace-ms').value = graceMs;

    const disableFavicons = settings.disableFavicons === true;
    document.getElementById('disable-favicons').checked = disableFavicons;

    const hideModelSections = settings.hideModelSections !== false;
    document.getElementById('show-model-sections-toggle').checked = !hideModelSections;

    const disableHardCap = settings.disableHardCap !== false ? true : false;
    document.getElementById('enable-hardcap').checked = !disableHardCap;

    const disableGraceWindow = settings.graceEnabled === false;
    const graceToggle = document.getElementById('disable-grace-window');
    if (graceToggle) graceToggle.checked = disableGraceWindow;

    const cacheDefaultModel = settings.cacheDefaultModel === true;
    const cacheToggle = document.getElementById('cache-default-model');
    if (cacheToggle) cacheToggle.checked = cacheDefaultModel;

    const enableShortcut = settings.shortcutEnabled !== false;
    const sendEnterAfter = settings.sendEnterAfterResult === true;
    const hkVal = typeof settings.hotkey === 'string' ? settings.hotkey : 'Alt+A';

    const hotkeyInput = document.getElementById('hotkey');
    const enableChk = document.getElementById('enable-shortcut');
    const sendEnterChk = document.getElementById('send-enter-after');

    if (enableChk) enableChk.checked = enableShortcut;
    if (sendEnterChk) sendEnterChk.checked = sendEnterAfter;
    if (hotkeyInput) hotkeyInput.value = hkVal;
    lastHotkeyValue = hkVal || 'Alt+A';

    checkModelSize();
    renderOverrides(settings.overrides || {}, settings.disableFavicons !== true);
    applyVisibility();

    isRestoring = false;
}

// Auto-save hooks
document.getElementById('model-select')?.addEventListener('change', () => {
    if (!isRestoring) {
        checkModelSize();
        saveDefaults(['local']);
    }
});
document.getElementById('language-select')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['local']); });
document.getElementById('silence-timeout')?.addEventListener('input', () => { if (!isRestoring) saveDefaults(['local']); });
document.getElementById('assemblyai-key')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['cloud']); });

function showSaved(area = 'save') {
    const map = {
        'engine': 'status-engine',
        'local': 'status-local',
        'cloud': 'status-cloud',
        'dev': 'status-dev',
        'overrides': 'status-overrides',
        'speech': 'status-speech',
        'save': 'status-save'
    };
    const id = map[area] || 'status-save';
    const el = document.getElementById(id);
    if (!el) return;

    if (statusTimers.has(id)) {
        clearTimeout(statusTimers.get(id));
    }
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