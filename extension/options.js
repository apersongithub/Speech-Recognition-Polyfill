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

// prevent UI echo loops while applying storage changes
let isApplyingExternalUpdate = false;

// remember selection in overrides list
let selectedOverrideHost = null;

// dropdown state for list visibility
let overridesListOpen = false;

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

    // backend indicator
    refreshBackendIndicator().catch(() => { });
    // Poll a bit so it updates after first model load; cheap + simple.
    setInterval(() => refreshBackendIndicator().catch(() => { }), 2000);
});

// Existing listeners
document.getElementById('open-assemblyai')?.addEventListener('click', () => {
    browser.tabs.create({ url: 'https://www.assemblyai.com/dashboard/api-keys', active: true });
});
document.getElementById('add-override')?.addEventListener('click', addOrUpdateOverride);
document.getElementById('remove-override')?.addEventListener('click', removeAllOverrides);

document.getElementById('debug-mode')?.addEventListener('change', () => saveDebugMode(['dev']));
document.getElementById('grace-ms')?.addEventListener('change', () => saveGraceSetting(['local']));
document.getElementById('factory-reset')?.addEventListener('click', factoryReset);
document.getElementById('disable-favicons')?.addEventListener('change', () => toggleFavicons(['dev']));

document.getElementById('show-model-sections-toggle')?.addEventListener('change', () => {
    if (!isRestoring) saveDefaults(['dev']);
    applyVisibility();
});
document.getElementById('provider-select')?.addEventListener('change', () => {
    if (!isRestoring) saveDefaults(['engine']);
    applyVisibility();
});
document.getElementById('enable-hardcap')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['dev']); });
document.getElementById('disable-grace-window')?.addEventListener('change', () => { if (!isRestoring) saveGraceSetting(['dev']); });
document.getElementById('cache-default-model')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['dev']); });
document.getElementById('strip-trailing-period')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['dev']); });
document.getElementById('boost-mic-gain')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['dev']); });

document.getElementById('enable-shortcut')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['speech']); });
document.getElementById('send-enter-after')?.addEventListener('change', () => { if (!isRestoring) saveDefaults(['speech']); });

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
        if (enableChk) enableChk.checked = true;
        hotkeyInput.blur();
        saveDefaults(['speech']);
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
function normalizeProvider(p) {
    return ALLOWED_PROVIDERS.includes(p) ? p : 'local-whisper';
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
function normalizeHost(host) { return (host || '').trim().toLowerCase(); }

function applyVisibility() {
    const showToggle = document.getElementById('show-model-sections-toggle')?.checked === true;
    const hideModelSections = !showToggle;
    const provider = document.getElementById('provider-select')?.value || 'local-whisper';
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

// Backend indicator helpers
function setBackendIndicator(backend) {
    const root = document.getElementById('backend-indicator');
    const valueEl = document.getElementById('backend-value');       // left value
    const chipEl = document.getElementById('backend-chip');         // right chip
    const chipText = document.getElementById('backend-chip-text');
    const hintEl = document.getElementById('backend-hint');

    if (!root || !valueEl || !chipEl || !chipText || !hintEl) return;

    const b = (backend || '').toLowerCase();

    // left value
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
        const active = (resp?.backend || '').toLowerCase(); // may be 'unloaded'
        const hasModelLoaded = !!resp?.hasModelLoaded;
        const w = resp?.webgpu;

        const webgpuUsable = !!(w && w.hasNavigatorGpu && w.adapterOk && w.deviceOk);

        // 1) If model is loaded, display the actual active backend.
        if (hasModelLoaded && (active === 'webgpu' || active === 'wasm')) {
            setBackendIndicator(active);
            return;
        }

        // 2) If model isn't loaded, display "enabled" based on preference+capability.
        if (preferred === 'webgpu' && webgpuUsable) {
            setBackendIndicator('webgpu');
            const hintEl = document.getElementById('backend-hint');
            if (hintEl) hintEl.textContent = t(
                'backend_hint_webgpu_enabled_supported',
                'WebGPU is enabled and supported. It will activate after the next local model load/transcription.'
            );
            return;
        }

        // 3) Otherwise, show wasm and explain why
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
    const language = document.getElementById('language-select')?.value || 'auto';
    const silenceTimeout = clampTimeout(document.getElementById('silence-timeout')?.value) ?? 1500;
    const provider = normalizeProvider(document.getElementById('provider-select')?.value);
    const assemblyaiApiKey = (document.getElementById('assemblyai-key')?.value || '').trim();
    const disableFavicons = document.getElementById('disable-favicons')?.checked === true;

    const showModelSections = document.getElementById('show-model-sections-toggle')?.checked === true;
    const hideModelSections = !showModelSections;

    // IMPORTANT: default should NOT be checked => hard cap disabled by default
    const enableHardCap = document.getElementById('enable-hardcap')?.checked === true;
    const disableHardCap = !enableHardCap;

    const cacheDefaultModel = document.getElementById('cache-default-model')?.checked === true;

    // Keep your existing semantics (checkbox label might be inverted, but preserve behavior)
    const stripTrailingPeriod = document.getElementById('strip-trailing-period')?.checked !== true;
    const boostMicGain = document.getElementById('boost-mic-gain')?.checked === true;

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

    // persisted dev flags
    settings.disableHardCap = disableHardCap;
    settings.cacheDefaultModel = cacheDefaultModel;
    settings.stripTrailingPeriod = stripTrailingPeriod;
    settings.boostMicGain = boostMicGain;

    // speech flags
    settings.shortcutEnabled = enableShortcut;
    settings.hotkey = hotkey;
    settings.sendEnterAfterResult = sendEnterAfter;
    lastHotkeyValue = hotkey;

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

async function addOrUpdateOverride() {
    const hostEl = document.getElementById('override-host');
    const host = normalizeHost(hostEl?.value);
    if (!host) return;

    const modelEl = document.getElementById('override-model');
    const langEl = document.getElementById('override-language');
    const timeoutEl = document.getElementById('override-timeout');
    const providerEl = document.getElementById('override-provider');
    const statusEl = document.getElementById('override-status');

    const model = modelEl?.value || null;
    const language = langEl?.value || null;
    const silenceTimeout = clampTimeout(timeoutEl?.value);
    const provider = providerEl?.value || null;

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
        ...(enabled ? {} : { enabled: false })
    };

    await browser.storage.local.set({ settings });

    // keep selection
    selectedOverrideHost = host;

    renderOverrides(settings.overrides, settings.disableFavicons !== true);

    hostEl.value = '';
    if (timeoutEl) timeoutEl.value = '';
    if (modelEl) modelEl.value = '';
    if (langEl) langEl.value = '';
    if (providerEl) providerEl.value = '';
    if (statusEl) statusEl.value = '';

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
        const favicon = showFavicons
            ? `<img class="fav-icon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32" onerror="this.style.display='none'">`
            : '';
        const tr = document.createElement('tr');
        tr.dataset.host = host;

        if (selectedOverrideHost && selectedOverrideHost === host) {
            tr.classList.add('selected');
        }

        const enabled = cfg?.enabled !== false;

        tr.innerHTML = `
          <td><span class="host-cell">${favicon}${host}</span></td>
          <td>${enabled ? 'Yes' : 'No'}</td>
          <td>${cfg.model || '—'}</td>
          <td>${cfg.language || '—'}</td>
          <td>${cfg.silenceTimeoutMs || '—'}</td>
          <td>${cfg.provider || '—'}</td>
          <td style="text-align:right;">
            <button class="row-delete" data-host="${host}" aria-label="Remove ${host}">✖</button>
          </td>
        `;
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

    document.getElementById('model-select').value = d.model || 'Xenova/whisper-base';
    document.getElementById('language-select').value = d.language || 'auto';
    document.getElementById('silence-timeout').value = d.silenceTimeoutMs || 1500;
    document.getElementById('provider-select').value = normalizeProvider(d.provider || 'local-whisper');
    document.getElementById('assemblyai-key').value = settings.assemblyaiApiKey || '';

    document.getElementById('debug-mode').checked = settings.debugMode === true;

    const graceMs = typeof settings.graceMs === 'number' ? settings.graceMs : 450;
    document.getElementById('grace-ms').value = graceMs;

    const disableFavicons = settings.disableFavicons === true;
    document.getElementById('disable-favicons').checked = disableFavicons;

    const hideModelSections = settings.hideModelSections !== false;
    document.getElementById('show-model-sections-toggle').checked = !hideModelSections;

    // IMPORTANT: default should NOT be checked => enable-hardcap false unless explicitly enabled
    const disableHardCap = settings.disableHardCap !== false; // default true (disabled)
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

    const boostMicGain = settings.boostMicGain === true;
    const boostToggle = document.getElementById('boost-mic-gain');
    if (boostToggle) boostToggle.checked = boostMicGain;

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

    // keep list collapsed by default after restore (unless user toggled open)
    applyOverridesListOpenState();

    refreshBackendIndicator().catch(() => { });

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

// ---------------- dropdown/collapse for the list ----------------
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

    // default: OPEN
    overridesListOpen = true;
    applyOverridesListOpenState();
}

// ---------------- click row -> load into inputs ----------------
function loadOverrideIntoInputs(host, cfg) {
    const hostEl = document.getElementById('override-host');
    const modelEl = document.getElementById('override-model');
    const langEl = document.getElementById('override-language');
    const timeoutEl = document.getElementById('override-timeout');
    const providerEl = document.getElementById('override-provider');
    const statusEl = document.getElementById('override-status');

    if (hostEl) hostEl.value = host || '';

    if (modelEl) modelEl.value = cfg?.model || '';
    if (langEl) langEl.value = (cfg?.language ?? '');
    if (timeoutEl) timeoutEl.value = (typeof cfg?.silenceTimeoutMs === 'number') ? String(cfg.silenceTimeoutMs) : '';
    if (providerEl) providerEl.value = cfg?.provider || '';
    if (statusEl) statusEl.value = (cfg?.enabled === false) ? 'disabled' : '';
}

function clearOverrideInputs() {
    const hostEl = document.getElementById('override-host');
    const modelEl = document.getElementById('override-model');
    const langEl = document.getElementById('override-language');
    const timeoutEl = document.getElementById('override-timeout');
    const providerEl = document.getElementById('override-provider');
    const statusEl = document.getElementById('override-status');

    if (hostEl) hostEl.value = '';
    if (modelEl) modelEl.value = '';
    if (langEl) langEl.value = '';
    if (timeoutEl) timeoutEl.value = '';
    if (providerEl) providerEl.value = '';
    if (statusEl) statusEl.value = '';

    selectedOverrideHost = null;

    // optional: remove row highlight immediately
    browser.storage.local.get('settings').then(({ settings }) => {
        renderOverrides(settings?.overrides || {}, settings?.disableFavicons !== true);
    }).catch(() => { });
}

function installOverrideRowClickToLoad() {
    const tbody = document.querySelector('#override-table tbody');
    if (!tbody) return;

    tbody.addEventListener('click', async (e) => {
        // ignore delete clicks (handled elsewhere)
        if (e.target.closest('.row-delete')) return;

        const row = e.target.closest('tr');
        const host = row?.dataset?.host;
        if (!host) return;

        const { settings } = await browser.storage.local.get('settings');
        const cfg = settings?.overrides?.[host] || {};

        selectedOverrideHost = host;
        loadOverrideIntoInputs(host, cfg);

        // highlight selection
        renderOverrides(settings?.overrides || {}, settings?.disableFavicons !== true);
    });
}

// ---------------- Live updates while options is open ----------------
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
                // Update overrides table instantly
                renderOverrides(next.overrides || {}, next.disableFavicons !== true);

                // keep toggles in sync
                const hideModelSections = next.hideModelSections !== false;
                const showToggle = document.getElementById('show-model-sections-toggle');
                if (showToggle) showToggle.checked = !hideModelSections;

                const providerSelect = document.getElementById('provider-select');
                const nextProvider = normalizeProvider(next?.defaults?.provider || 'local-whisper');
                if (providerSelect && providerSelect.value !== nextProvider) providerSelect.value = nextProvider;
                applyVisibility();

                const favToggle = document.getElementById('disable-favicons');
                if (favToggle) favToggle.checked = next.disableFavicons === true;

                const stripToggle = document.getElementById('strip-trailing-period');
                if (stripToggle) stripToggle.checked = next.stripTrailingPeriod === false;

                const boostToggle = document.getElementById('boost-mic-gain');
                if (boostToggle) boostToggle.checked = next.boostMicGain === true;

                const d = next.defaults || {};
                const modelEl = document.getElementById('model-select');
                const langEl = document.getElementById('language-select');
                const silenceEl = document.getElementById('silence-timeout');
                if (modelEl && d.model && modelEl.value !== d.model) modelEl.value = d.model;
                if (langEl && d.language && langEl.value !== d.language) langEl.value = d.language;
                if (silenceEl && typeof d.silenceTimeoutMs === 'number' && String(silenceEl.value) !== String(d.silenceTimeoutMs)) {
                    silenceEl.value = d.silenceTimeoutMs;
                }

                const debugEl = document.getElementById('debug-mode');
                if (debugEl) debugEl.checked = next.debugMode === true;

                // IMPORTANT: default should NOT be checked
                const enableHardcapEl = document.getElementById('enable-hardcap');
                if (enableHardcapEl) {
                    const disableHardCap = next.disableHardCap !== false; // default true (disabled)
                    enableHardcapEl.checked = !disableHardCap;
                }

                const cacheEl = document.getElementById('cache-default-model');
                if (cacheEl) cacheEl.checked = next.cacheDefaultModel === true;

                const graceMsEl = document.getElementById('grace-ms');
                if (graceMsEl) graceMsEl.value = (typeof next.graceMs === 'number') ? next.graceMs : 450;

                const disableGraceEl = document.getElementById('disable-grace-window');
                if (disableGraceEl) disableGraceEl.checked = next.graceEnabled === false;

                const enableShortcutEl = document.getElementById('enable-shortcut');
                if (enableShortcutEl) enableShortcutEl.checked = next.shortcutEnabled !== false;

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

                refreshBackendIndicator().catch(() => { });
            } finally {
                isApplyingExternalUpdate = false;
            }
        });
    } catch (_) { }
}

// ---------------- Import / Export ----------------
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
            if (p && !ALLOWED_PROVIDERS.includes(p)) incomingSettings.defaults.provider = 'local-whisper';
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