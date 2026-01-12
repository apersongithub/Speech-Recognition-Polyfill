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

document.addEventListener('DOMContentLoaded', () => {
    applyI18n();
    restoreOptions();
});
document.getElementById('save-btn').addEventListener('click', saveDefaults);
document.getElementById('add-override').addEventListener('click', addOrUpdateOverride);
document.getElementById('remove-override').addEventListener('click', removeOverride);
document.getElementById('model-select').addEventListener('change', checkModelSize);
document.getElementById('debug-mode').addEventListener('change', saveDebugMode); // Auto-save checkbox

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

async function saveDefaults() {
    const model = document.getElementById('model-select').value;
    const language = document.getElementById('language-select').value;
    const silenceTimeout = clampTimeout(document.getElementById('silence-timeout').value) || 1500;

    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    settings.defaults = { model, language, silenceTimeoutMs: silenceTimeout };
    
    await browser.storage.local.set({ settings });
    showSaved();
    browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
}

// Separate saver for the Debug Toggle
async function saveDebugMode() {
    const debugMode = document.getElementById('debug-mode').checked;
    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    settings.debugMode = debugMode;
    
    await browser.storage.local.set({ settings });
    browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
}

async function addOrUpdateOverride() {
    const host = normalizeHost(document.getElementById('override-host').value);
    if (!host) return;
    
    const model = document.getElementById('override-model').value || null;
    const language = document.getElementById('override-language').value || null;
    const silenceTimeout = clampTimeout(document.getElementById('override-timeout').value);

    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    settings.overrides = settings.overrides || {};

    settings.overrides[host] = {
        ...(model ? { model } : {}),
        ...(language ? { language } : {}),
        ...(silenceTimeout ? { silenceTimeoutMs: silenceTimeout } : {})
    };

    await browser.storage.local.set({ settings });
    renderOverrides(settings.overrides);
    showSaved();
    browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
}

async function removeOverride() {
    const host = normalizeHost(document.getElementById('override-host').value);
    if (!host) return;
    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    if (settings.overrides && settings.overrides[host]) {
        delete settings.overrides[host];
        await browser.storage.local.set({ settings });
        renderOverrides(settings.overrides);
        showSaved();
        browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
    }
}

function renderOverrides(overrides) {
    const tbody = document.querySelector('#override-table tbody');
    tbody.innerHTML = '';
    if (!overrides) return;
    Object.entries(overrides).forEach(([host, cfg]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${host}</td>
          <td>${cfg.model || '—'}</td>
          <td>${cfg.language || '—'}</td>
          <td>${cfg.silenceTimeoutMs || '—'}</td>
        `;
        tbody.appendChild(tr);
    });
}

async function restoreOptions() {
    const stored = await browser.storage.local.get('settings');
    const settings = stored.settings || {};
    const d = settings.defaults || {};
    
    document.getElementById('model-select').value = d.model || 'Xenova/whisper-tiny';
    document.getElementById('language-select').value = d.language || 'auto';
    document.getElementById('silence-timeout').value = d.silenceTimeoutMs || 1500;
    
    document.getElementById('debug-mode').checked = settings.debugMode || false;

    checkModelSize();
    renderOverrides(settings.overrides || {});
}

function showSaved() {
    const status = document.getElementById('status');
    status.style.opacity = '1';
    setTimeout(() => { status.style.opacity = '0'; }, 1500);
}