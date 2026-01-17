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

function t(key, fallback = '') {
    return browser.i18n?.getMessage(key) || fallback;
}

function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const msg = t(key);
        if (!msg) return;

        const tag = el.tagName;

        if (tag === 'OPTGROUP') { el.label = msg; return; }
        if (tag === 'OPTION') { el.textContent = msg; return; }
        if (el.children && el.children.length > 0) return;

        el.textContent = msg;
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

    await browser.storage.local.set({ settings });
    browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
    statusKeys.forEach(k => showSaved(k));
}

async function saveDebugMode(statusKeys = []) {
    if (isRestoring) return;
    const debugMode = document.getElementById('debug-mode').checked;
    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    settings.debugMode = debugMode;
    await browser.storage.local.set({ settings });
    browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
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
    browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });

    statusKeys.forEach(k => showSaved(k));
}

async function addOrUpdateOverride() {
    const host = normalizeHost(document.getElementById('override-host').value);
    if (!host) return;
    
    const model = document.getElementById('override-model').value || null;
    const language = document.getElementById('override-language').value || null;
    const silenceTimeout = clampTimeout(document.getElementById('override-timeout').value);
    const provider = document.getElementById('override-provider').value || null;

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
    showSaved('overrides');
    browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
}

async function removeAllOverrides() {
    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    settings.overrides = {};
    await browser.storage.local.set({ settings });
    renderOverrides(settings.overrides, settings.disableFavicons !== true);
    showSaved('overrides');
    browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
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
        browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
    }
}

function renderOverrides(overrides, showFavicons) {
    const tbody = document.querySelector('#override-table tbody');
    tbody.innerHTML = '';
    if (!overrides) return;
    Object.entries(overrides).forEach(([host, cfg]) => {
        const favicon = showFavicons ? `<img class="fav-icon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32" onerror="this.style.display='none'">` : '';
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

// per-row delete handler (event delegation)
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
    browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
    await restoreOptions();
}

async function restoreOptions() {
    isRestoring = true;
    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    const d = settings.defaults || {};
    
    document.getElementById('model-select').value = d.model || 'Xenova/whisper-tiny';
    document.getElementById('language-select').value = d.language || 'auto';
    document.getElementById('silence-timeout').value = d.silenceTimeoutMs || 1500;
    document.getElementById('provider-select').value = normalizeProvider(d.provider || 'local-whisper');
    document.getElementById('assemblyai-key').value = settings.assemblyaiApiKey || '';

    document.getElementById('debug-mode').checked = settings.debugMode || false;

    const graceEnabled = settings.graceEnabled !== false; // default true
    const graceMs = typeof settings.graceMs === 'number' ? settings.graceMs : 450;
    document.getElementById('grace-ms').value = graceMs;

    const disableFavicons = settings.disableFavicons === true;
    document.getElementById('disable-favicons').checked = disableFavicons;

    const hideModelSections = settings.hideModelSections !== false; // default hide (so toggle unchecked)
    document.getElementById('show-model-sections-toggle').checked = !hideModelSections;

    const disableHardCap = settings.disableHardCap !== false ? true : false; // default: disable hard cap
    document.getElementById('enable-hardcap').checked = !disableHardCap;

    const disableGraceWindow = settings.graceEnabled === false;
    const graceToggle = document.getElementById('disable-grace-window');
    if (graceToggle) graceToggle.checked = disableGraceWindow;

    const cacheDefaultModel = settings.cacheDefaultModel === true;
    const cacheToggle = document.getElementById('cache-default-model');
    if (cacheToggle) cacheToggle.checked = cacheDefaultModel;

    checkModelSize();
    renderOverrides(settings.overrides || {}, settings.disableFavicons !== true);
    applyVisibility();
    isRestoring = false;
}

// Auto-save hooks for defaults (single-section statuses)
document.getElementById('model-select')?.addEventListener('change', () => {
    if (!isRestoring) {
        checkModelSize();          // <-- show warning immediately on change
        saveDefaults(['local']);
    }
});
document.getElementById('language-select')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['local']); });
document.getElementById('silence-timeout')?.addEventListener('input', () => { if (!isRestoring) saveDefaults(['local']); });
document.getElementById('assemblyai-key')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['cloud']); });
document.getElementById('debug-mode')?.addEventListener('change', () => { if (!isRestoring) saveDebugMode(['dev']); });

function showSaved(area = 'save') {
    const map = {
        'engine': 'status-engine',
        'local': 'status-local',
        'cloud': 'status-cloud',
        'dev': 'status-dev',
        'overrides': 'status-overrides',
        'save': 'status-save'
    };
    const id = map[area] || 'status-save';
    const el = document.getElementById(id);
    if (!el) return;
    el.style.opacity = '1';
    setTimeout(() => { el.style.opacity = '0'; }, 1200);
}