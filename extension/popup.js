const ALLOWED_MODELS = new Set([
  'Xenova/whisper-tiny.en',
  'Xenova/whisper-tiny',
  'Xenova/whisper-base.en',
  'Xenova/whisper-base',
  'Xenova/whisper-small.en',
  'Xenova/whisper-small',
  'Xenova/distil-whisper-medium.en'
]);

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

async function getActiveHostname() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const url = tabs[0]?.url || '';
  try { return new URL(url).hostname; } catch { return ''; }
}

async function loadState() {
  const host = await getActiveHostname();
  document.getElementById('host-label').textContent = host ? `${t('popup_site_prefix', 'Site')}: ${host}` : t('popup_site_unknown', 'Site: (unknown)');
  const { settings } = await browser.storage.local.get('settings');
  const overrides = settings?.overrides || {};
  const o = overrides[host] || {};
  document.getElementById('model').value = o.model || '';
  document.getElementById('language').value = o.language || '';
  document.getElementById('timeout').value = o.silenceTimeoutMs ?? '';
}

async function saveOverride() {
  const host = await getActiveHostname();
  if (!host) return;
  const model = document.getElementById('model').value;
  const language = document.getElementById('language').value;
  const timeout = clampTimeout(document.getElementById('timeout').value);
  if (model && !ALLOWED_MODELS.has(model)) {
    alert(t('model_not_allowed', 'Model not allowed.'));
    return;
  }
  const { settings } = await browser.storage.local.get('settings');
  const next = settings || {};
  // only the defaults fallback needs to change inside saveOverride()
  next.defaults = next.defaults || { model: 'Xenova/whisper-tiny', language: 'auto', silenceTimeoutMs: 1500 };
  next.overrides = next.overrides || {};
  const override = {};
  if (model) override.model = model;
  if (language) override.language = language;
  if (timeout) override.silenceTimeoutMs = timeout;
  next.overrides[host] = override;
  await browser.storage.local.set({ settings: next });
  notifySaved();
  browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
}

async function removeOverride() {
  const host = await getActiveHostname();
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
  setTimeout(() => s.classList.remove('show'), 1400);
}

document.getElementById('save').addEventListener('click', saveOverride);
document.getElementById('remove').addEventListener('click', removeOverride);
document.getElementById('open-options').addEventListener('click', () => browser.runtime.openOptionsPage());

applyI18n();
loadState();