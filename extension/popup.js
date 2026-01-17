const ALLOWED_MODELS = new Set([
  'Xenova/whisper-tiny.en',
  'Xenova/whisper-tiny',
  'Xenova/whisper-base.en',
  'Xenova/whisper-base',
  'Xenova/whisper-small.en',
  'Xenova/whisper-small',
  'Xenova/distil-whisper-medium.en'
]);
const ALLOWED_PROVIDERS = new Set(['local-whisper', 'assemblyai']);

function t(key, fallback = '') { return browser.i18n?.getMessage(key) || fallback; }

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const msg = t(key);
    if (msg) el.textContent = msg;
  });
  const timeout = document.getElementById('timeout');
  if (timeout) timeout.placeholder = t('popup_timeout_placeholder', timeout.placeholder || 'Use default');
}

function clampTimeout(val) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return null;
  return Math.max(500, Math.min(5000, n));
}

function normalizeProvider(p) {
  return ALLOWED_PROVIDERS.has(p) ? p : '';
}

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function applyPopupVisibility(provider, hideToggle) {
  const modelSection = document.getElementById('model-section');
  const modelHeader = document.getElementById('model-section-header');
  if (!modelSection || !modelHeader) return;
  if (!hideToggle) {
    modelSection.style.display = '';
    modelHeader.style.display = '';
    return;
  }
  if (provider === 'assemblyai') {
    modelSection.style.display = 'none';
    modelHeader.style.display = 'none';
  } else {
    modelSection.style.display = '';
    modelHeader.style.display = '';
  }
}

async function loadState() {
  const tab = await getActiveTab();
  const url = tab?.url || '';
  let host = '';
  try { host = new URL(url).hostname; } catch { host = ''; }
  const hostLabel = document.getElementById('host-label');
  hostLabel.textContent = host ? `${t('popup_site_prefix', 'Site')}: ${host}` : t('popup_site_unknown', 'Site: (unknown)');

  const iconEl = document.getElementById('host-favicon');
  const fav = tab?.favIconUrl;
  if (fav) {
    iconEl.style.display = 'inline-block';
    iconEl.onerror = () => { iconEl.style.display = 'none'; };
    iconEl.src = fav;
  } else {
    iconEl.style.display = 'none';
  }

  const { settings } = await browser.storage.local.get('settings');
  const overrides = settings?.overrides || {};
  const o = overrides[host] || {};
  const provider = o.provider || '';
  document.getElementById('model').value = o.model || '';
  document.getElementById('language').value = o.language || '';
  document.getElementById('timeout').value = o.silenceTimeoutMs ?? '';
  document.getElementById('provider').value = provider;
  const hideToggle = settings?.hideModelSections !== false; // shared single toggle from options
  applyPopupVisibility(provider, hideToggle);
}

async function saveOverride(autoText) {
  const tab = await getActiveTab();
  let host = '';
  try { host = new URL(tab?.url || '').hostname; } catch { host = ''; }
  if (!host) return;
  const model = document.getElementById('model').value;
  const language = document.getElementById('language').value;
  const timeout = clampTimeout(document.getElementById('timeout').value);
  const provider = normalizeProvider(document.getElementById('provider').value);

  if (model && !ALLOWED_MODELS.has(model)) {
    alert(t('model_not_allowed', 'Model not allowed.'));
    return;
  }
  const { settings } = await browser.storage.local.get('settings');
  const next = settings || {};
  next.defaults = next.defaults || { model: 'Xenova/whisper-tiny', language: 'auto', silenceTimeoutMs: 1500, provider: 'local-whisper' };
  // respect the single toggle from options; do not change here
  next.hideModelSections = settings?.hideModelSections !== false;
  next.overrides = next.overrides || {};
  const override = {};
  if (model) override.model = model;
  if (language) override.language = language;
  if (timeout) override.silenceTimeoutMs = timeout;
  if (provider) override.provider = provider;
  next.overrides[host] = override;
  await browser.storage.local.set({ settings: next });
  notifySaved(autoText || t('popup_status_saved', 'Saved'));
  browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
  applyPopupVisibility(provider, next.hideModelSections !== false);
}

async function removeOverride() {
  const tab = await getActiveTab();
  let host = '';
  try { host = new URL(tab?.url || '').hostname; } catch { host = ''; }
  if (!host) return;
  const { settings } = await browser.storage.local.get('settings');
  const next = settings || {};
  if (next.overrides && next.overrides[host]) {
    delete next.overrides[host];
    await browser.storage.local.set({ settings: next });
    notifySaved(t('popup_removed', 'Removed'));
    browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
    await loadState();
  }
}

function notifySaved(text = t('popup_status_saved', 'Saved')) {
  const s = document.getElementById('status');
  s.textContent = text;
  s.classList.add('show');
  setTimeout(() => s.classList.remove('show'), 1200);
}

// Auto-save on change
['model','language','timeout','provider'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  const evt = (id === 'timeout') ? 'input' : 'change';
  el.addEventListener(evt, () => {
    if (id === 'provider') {
      browser.storage.local.get('settings').then(({ settings }) => {
        applyPopupVisibility(el.value, settings?.hideModelSections !== false);
      });
    }
    saveOverride();
  });
});

document.getElementById('remove').addEventListener('click', removeOverride);
document.getElementById('open-options').addEventListener('click', () => browser.runtime.openOptionsPage());

applyI18n();
loadState();