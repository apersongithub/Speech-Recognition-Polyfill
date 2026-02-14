const ALLOWED_MODELS = new Set([
  'Xenova/whisper-tiny.en',
  'Xenova/whisper-tiny',
  'Xenova/whisper-base.en',
  'Xenova/whisper-base',
  'Xenova/whisper-small.en',
  'Xenova/whisper-small',
  'Xenova/distil-whisper-medium.en'
]);

const ALLOWED_PROVIDERS = new Set(['local-whisper', 'assemblyai', 'vosk']);
const VOSK_MODEL_INDEX_URL = 'https://alphacephei.com/vosk/models/model-list.json';

let voskModelIndex = new Map();
let voskModelIndexPromise = null;

function t(key, fallback = '') { return browser.i18n?.getMessage(key) || fallback; }

function applyI18n() {
  const titleMsg = t('popup_page_title');
  if (titleMsg) document.title = titleMsg;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const msg = t(key);
    if (msg) el.textContent = msg;
  });

  const timeout = document.getElementById('timeout');
  if (timeout) timeout.placeholder = t('popup_timeout_placeholder', timeout.placeholder || 'Use default');
}

function parseVoskModelList(payload) {
  const list = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.models) ? payload.models : []);
  return list.map((entry) => {
    const id = entry?.name || entry?.id || entry?.model || entry?.model_id;
    const url = entry?.url || entry?.link || entry?.download;
    const size = entry?.size || entry?.size_mb || entry?.sizeMB || entry?.size_in_mb;
    const lang = entry?.lang || entry?.language || entry?.locale;
    if (!id) return null;
    return { id, url, size, lang };
  }).filter(Boolean);
}

function setVoskModelDatalist(list) {
  const datalist = document.getElementById('vosk-model-list');
  if (!datalist) return;
  datalist.innerHTML = '';

  const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id));
  for (const model of sorted) {
    const option = document.createElement('option');
    option.value = model.id;
    datalist.appendChild(option);
  }
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
      console.warn('[Popup] Failed to load Vosk model list', e);
    }
    return false;
  })();

  try {
    return await voskModelIndexPromise;
  } finally {
    voskModelIndexPromise = null;
  }
}

function clampTimeout(val) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return null;
  return Math.max(500, Math.min(5000, n));
}

function clampGrace(val) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return null;
  return Math.max(0, Math.min(2000, n));
}

function normalizeProvider(p) {
  return ALLOWED_PROVIDERS.has(p) ? p : '';
}

function isVoskModel(id) {
  if (!id) return false;
  if (voskModelIndex.size > 0) return voskModelIndex.has(id);
  return id.startsWith('vosk-model-');
}

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function applyPopupVisibility(provider, hideToggle) {
  const modelSection = document.getElementById('model-section');
  const modelHeader = document.getElementById('model-section-header');
  const whisperSelect = document.getElementById('model');
  const voskInput = document.getElementById('vosk-model');

  if (!modelSection || !modelHeader || !whisperSelect || !voskInput) return;

  if (!hideToggle) {
    modelSection.style.display = '';
    modelHeader.style.display = '';
  } else if (provider === 'assemblyai') {
    modelSection.style.display = 'none';
    modelHeader.style.display = 'none';
  } else {
    modelSection.style.display = '';
    modelHeader.style.display = '';
  }

  const showVosk = provider === 'vosk';
  whisperSelect.style.display = showVosk ? 'none' : '';
  voskInput.style.display = showVosk ? '' : 'none';
}

async function loadState() {
  await ensureVoskModelIndex();

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
  document.getElementById('model').value = '';
  document.getElementById('vosk-model').value = '';
  if (o.model) {
    if (isVoskModel(o.model)) {
      document.getElementById('vosk-model').value = o.model;
    } else {
      document.getElementById('model').value = o.model;
    }
  }
  document.getElementById('language').value = o.language || '';
  document.getElementById('timeout').value = o.silenceTimeoutMs ?? '';
  document.getElementById('provider').value = provider;
  document.getElementById('grace-ms').value = o.graceMs ?? '';

  const siteStatus = document.getElementById('site-status');
  if (siteStatus) siteStatus.value = (o.enabled === false) ? 'disabled' : '';

  const hideToggle = settings?.hideModelSections !== false;
  applyPopupVisibility(provider || settings?.defaults?.provider || 'vosk', hideToggle);
}

async function saveOverride(autoText) {
  const tab = await getActiveTab();
  let host = '';
  try { host = new URL(tab?.url || '').hostname; } catch { host = ''; }
  if (!host) return;

  let provider = normalizeProvider(document.getElementById('provider').value);
  const whisperModel = document.getElementById('model').value;
  const voskModel = document.getElementById('vosk-model').value.trim();

  // If provider isn't explicitly set, infer it from the selected model
  let model = null;
  if (voskModel) {
    model = voskModel;
    if (!provider) provider = 'vosk';
  } else if (whisperModel) {
    model = whisperModel;
    if (!provider) provider = 'local-whisper';
  }

  const language = document.getElementById('language').value;
  const timeout = clampTimeout(document.getElementById('timeout').value);
  const graceMs = clampGrace(document.getElementById('grace-ms').value);

  const siteStatus = (document.getElementById('site-status')?.value || '').trim();
  const enabled = (siteStatus !== 'disabled');

  if (model) {
    const ok = ALLOWED_MODELS.has(model) || isVoskModel(model);
    if (!ok) {
      alert(t('model_not_allowed', 'Model not allowed.'));
      return;
    }
  }

  const { settings } = await browser.storage.local.get('settings');
  const next = settings || {};
  next.defaults = next.defaults || { model: 'Xenova/whisper-base', language: 'auto', silenceTimeoutMs: 1500, provider: 'vosk' };
  next.hideModelSections = settings?.hideModelSections !== false;
  next.overrides = next.overrides || {};

  const override = {};
  if (model) override.model = model;
  if (language) override.language = language;
  if (timeout) override.silenceTimeoutMs = timeout;
  if (provider) override.provider = provider;
  if (graceMs != null) override.graceMs = graceMs;
  if (!enabled) override.enabled = false;

  next.overrides[host] = override;
  await browser.storage.local.set({ settings: next });
  notifySaved(autoText || t('popup_status_saved', 'Saved'));
  browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
  applyPopupVisibility(provider || next?.defaults?.provider || 'vosk', next.hideModelSections !== false);
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

['model', 'language', 'timeout', 'provider', 'site-status', 'grace-ms'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  const evt = (id === 'timeout' || id === 'grace-ms') ? 'input' : 'change';
  el.addEventListener(evt, () => {
    if (id === 'provider') {
      browser.storage.local.get('settings').then(({ settings }) => {
        applyPopupVisibility(el.value || settings?.defaults?.provider || 'vosk', settings?.hideModelSections !== false);
      });
    }
    saveOverride();
  });
});

function sizeToMb(size) {
    const n = typeof size === 'number' ? size : parseFloat(size);
    if (!Number.isFinite(n)) return null;
    const bytes = n > 1_000_000 ? n : n * 1024 * 1024;
    return bytes / (1024 * 1024);
}

function setVoskModelDatalist(list) {
    const datalist = document.getElementById('vosk-model-list');
    if (!datalist) return;
    datalist.innerHTML = '';

    const filtered = list.filter((model) => {
        const mb = sizeToMb(model?.size);
        return mb == null || mb <= 1042;
    });

    const sorted = filtered.sort((a, b) => a.id.localeCompare(b.id));
    for (const model of sorted) {
        const option = document.createElement('option');
        option.value = model.id;
        datalist.appendChild(option);
    }
}

const voskModelInput = document.getElementById('vosk-model');
if (voskModelInput) {
  voskModelInput.addEventListener('input', () => {
    // allow typing without validation
  });
  voskModelInput.addEventListener('change', () => {
    saveOverride();
  });
}

document.getElementById('remove').addEventListener('click', removeOverride);
document.getElementById('open-options').addEventListener('click', () => browser.runtime.openOptionsPage());

applyI18n();
loadState();