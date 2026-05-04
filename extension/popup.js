const ALLOWED_MODELS = new Set([
  'Xenova/whisper-tiny.en',
  'Xenova/whisper-tiny',
  'Xenova/whisper-base.en',
  'Xenova/whisper-base',
  'Xenova/whisper-small.en',
  'Xenova/whisper-small',
  'Xenova/distil-whisper-medium.en'
]);

const ALLOWED_PROVIDERS = new Set(['local-whisper', 'assemblyai', 'vosk', 'google']);
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

// --- In popup.js ---

// 1. Update Parser
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
      version: entry?.version // NEW
    };
  }).filter(Boolean);
}

// 2. Update Display Logic
window.VOSK_PRETTY_TO_ID = new Map();
window.VOSK_ID_TO_PRETTY = new Map();

function setVoskModelDatalist(list) {
  const datalist = document.getElementById('vosk-model-list');
  const realInput = document.getElementById('vosk-model'); // Popup ID

  if (!datalist || !realInput) return;

  datalist.innerHTML = '';
  window.VOSK_PRETTY_TO_ID.clear();
  window.VOSK_ID_TO_PRETTY.clear();

  let prettyInput = document.getElementById('vosk-model-pretty-display');
  if (!prettyInput) {
    prettyInput = document.createElement('input');
    prettyInput.id = 'vosk-model-pretty-display';
    prettyInput.type = 'text';
    prettyInput.className = realInput.className || '';
    prettyInput.style.cssText = "width: 100%; box-sizing: border-box; margin-bottom: 8px;";
    prettyInput.placeholder = "Type or double click to select a model...";

    prettyInput.setAttribute('list', 'vosk-model-list');
    realInput.removeAttribute('list');
    realInput.style.display = 'none';
    realInput.parentNode.insertBefore(prettyInput, realInput);

    prettyInput.addEventListener('input', () => {
      const val = prettyInput.value;
      const id = window.VOSK_PRETTY_TO_ID.get(val);
      realInput.value = id || val;
      realInput.dispatchEvent(new Event('change'));
      realInput.dispatchEvent(new Event('input'));
    });

    prettyInput.addEventListener('focus', () => {
      prettyInput.dataset.previousValue = realInput.value;
      prettyInput.value = '';
    });

    prettyInput.addEventListener('blur', () => {
      const val = prettyInput.value.trim();
      const isPretty = window.VOSK_PRETTY_TO_ID.has(val);
      const isId = window.VOSK_ID_TO_PRETTY.has(val);

      if (val && (isPretty || isId)) {
        realInput.value = isPretty ? window.VOSK_PRETTY_TO_ID.get(val) : val;
      } else {
        realInput.value = prettyInput.dataset.previousValue || '';
      }

      const finalVal = realInput.value;
      prettyInput.value = window.VOSK_ID_TO_PRETTY.get(finalVal) || finalVal;
      
      realInput.dispatchEvent(new Event('change'));
      realInput.dispatchEvent(new Event('input'));
    });
  }

  const filtered = list.filter((model) => {
    const mb = sizeToMb(model?.size);
    return (mb == null || mb <= 1042) && !/spk|tts/i.test(model.id);
  });

  const sorted = filtered.sort((a, b) => {
    if (a.obsolete !== b.obsolete) return a.obsolete ? 1 : -1;
    return a.id.localeCompare(b.id);
  });

  for (const model of sorted) {
    const option = document.createElement('option');

    let prettyName = model.langText || autoPrettifyVoskId(model.id);

    const extras = [];

    // NEW: Add Version
    if (model.version) extras.push(`v${model.version}`);

    if (model.type && model.type !== 'small') extras.push(model.type);
    else if (model.id.includes('small') && !model.type) extras.push('small');

    if (model.sizeText) extras.push(model.sizeText);

    if (extras.length > 0) prettyName += ` (${extras.join(', ')})`;
    if (model.obsolete) prettyName = `⚠️ [OBSOLETE] ${prettyName}`;

    window.VOSK_PRETTY_TO_ID.set(prettyName, model.id);
    window.VOSK_ID_TO_PRETTY.set(model.id, prettyName);

    option.value = prettyName;
    datalist.appendChild(option);
  }

  if (realInput.value) {
    const pretty = window.VOSK_ID_TO_PRETTY.get(realInput.value);
    prettyInput.value = pretty || realInput.value;
  }
}

function autoPrettifyVoskId(id) {
  let s = id.replace(/^vosk-model-/, '').replace(/-/g, ' ');
  s = s.replace(/\b\w/g, l => l.toUpperCase());

  const langMap = {
    'En Us': 'English (US)',
    'En In': 'English (India)',
    'En': 'English',
    'Cn': 'Chinese',
    'Ru': 'Russian',
    'Fr': 'French',
    'De': 'German',
    'Es': 'Spanish',
    'Pt': 'Portuguese',
    'It': 'Italian',
    'Tr': 'Turkish',
    'Vn': 'Vietnamese',
    'Ja': 'Japanese',
    'Hi': 'Hindi',
    'Fa': 'Persian',
    'Uk': 'Ukrainian',
    'Kz': 'Kazakh',
    'Sv': 'Swedish',
    'Ca': 'Catalan',
    'Ar': 'Arabic',
    'Nl': 'Dutch',
    'Ni': 'Dutch',
    'El Gr': 'Greek'
  };

  Object.keys(langMap).sort((a, b) => b.length - a.length).forEach(code => {
    const re = new RegExp(`\\b${code}\\b`, 'g');
    s = s.replace(re, langMap[code]);
  });

  return s;
}

async function ensureVoskModelIndex() {
  if (voskModelIndexPromise) return voskModelIndexPromise;

  voskModelIndexPromise = (async () => {
    try {
      const cached = await browser.storage.local.get('voskModelCache');
      const now = Date.now();
      let data = null;

      if (cached.voskModelCache && cached.voskModelCache.data && (now - cached.voskModelCache.timestamp < 7 * 24 * 60 * 60 * 1000)) {
        data = cached.voskModelCache.data;
      } else {
        const resp = await fetch(VOSK_MODEL_INDEX_URL);
        if (!resp.ok) throw new Error(`Failed to fetch Vosk models: ${resp.status}`);
        data = await resp.json();
        await browser.storage.local.set({ voskModelCache: { data, timestamp: now } });
      }

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

// replace existing applyPopupVisibility(...) in popup.js with this corrected version
function applyPopupVisibility(provider, hideToggle) {
  const modelSection = document.getElementById('model-section');
  const modelHeader = document.getElementById('model-section-header');
  const whisperSelect = document.getElementById('model');
  const voskInput = document.getElementById('vosk-model');          // original (hidden) input
  const prettyVosk = document.getElementById('vosk-model-pretty-display'); // pretty visible input (created by setVoskModelDatalist)
  const googleServerMode = document.getElementById('google-server-mode');

  if (!modelSection || !modelHeader || !whisperSelect || !voskInput) return;

  const showVosk = provider === 'vosk';
  const showGoogle = provider === 'google';
  const showWhisper = provider === 'local-whisper';

  if (!hideToggle) {
    modelSection.style.display = '';
    modelHeader.style.display = '';
  } else if (provider === 'assemblyai') {
    // AssemblyAI doesn't use local models
    modelSection.style.display = 'none';
    modelHeader.style.display = 'none';
  } else {
    modelSection.style.display = '';
    modelHeader.style.display = '';
  }

  // Toggle internal model controls based on provider
  if (whisperSelect) whisperSelect.style.display = showWhisper || !provider ? '' : 'none';
  if (prettyVosk) prettyVosk.style.display = showVosk ? '' : 'none';
  if (voskInput) voskInput.style.display = 'none';
  if (googleServerMode) googleServerMode.style.display = showGoogle ? '' : 'none';
}



async function saveOverride(autoText) {
  const tab = await getActiveTab();
  let host = '';
  try { host = new URL(tab?.url || '').hostname; } catch { host = ''; }
  if (!host) return;

  const providerEl = document.getElementById('provider');
  const whisperModelEl = document.getElementById('model');
  const voskModelEl = document.getElementById('vosk-model');

  let provider = normalizeProvider(providerEl.value);
  const whisperModel = whisperModelEl.value;
  const voskModel = voskModelEl.value.trim();

  let model = null;

  // --- LOGIC FIX: Handle each provider explicitly ---
  if (provider === 'local-whisper') {
    model = whisperModel;
  } else if (provider === 'vosk') {
    model = voskModel;
  } else if (provider === 'assemblyai') {
    model = null;
  } else if (provider === 'google') {
    model = null;
  } else {
    // If "Use Default" is selected, try to infer from what is typed/selected
    // Only infer from the input that is currently VISIBLE to prevent hidden inputs from hijacking
    const prettyVosk = document.getElementById('vosk-model-pretty-display');
    const whisperSelectEl = document.getElementById('model');

    if (prettyVosk && prettyVosk.style.display !== 'none' && voskModel) {
      model = voskModel;
      provider = 'vosk';
    } else if (whisperSelectEl && whisperSelectEl.style.display !== 'none' && whisperModel) {
      model = whisperModel;
      provider = 'local-whisper';
    }
  }

  // --- Vosk Size Validation ---
  if (provider === 'vosk' && model) {
    const meta = voskModelIndex.get(model);
    if (meta?.size != null) {
      const mb = sizeToMb(meta.size);
      if (mb != null && mb > 1024) {
        alert(`Selected Vosk model (${model}) is ${Math.round(mb)} MB which exceeds the 1024 MB limit.`);
        return;
      }
    }
  }

  const language = (document.getElementById('language').value || '').trim();
  const timeout = clampTimeout(document.getElementById('timeout').value);
  const graceMs = clampGrace(document.getElementById('grace-ms').value);
  const siteStatus = (document.getElementById('site-status')?.value || '').trim();
  const enabled = (siteStatus !== 'disabled');

  const { settings } = await browser.storage.local.get('settings');
  const next = settings || {};
  next.overrides = next.overrides || {};

  // Build the override object
  const override = {};
  if (model) override.model = model;
  if (language) override.language = language;
  if (timeout) override.silenceTimeoutMs = timeout;
  if (provider) override.provider = provider;
  if (graceMs != null) override.graceMs = graceMs;
  if (!enabled) override.enabled = false;

  // Save Google Server Mode if Google provider is selected
  const googleServerMode = (document.getElementById('google-server-mode')?.value || '').trim();
  if (googleServerMode) override.googleServerMode = googleServerMode;

  next.overrides[host] = override;

  await browser.storage.local.set({ settings: next });
  notifySaved(autoText || t('popup_status_saved', 'Saved'));

  // Notify background script to refresh its settings
  browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });

  // Update visibility of the UI sections
  const hideToggle = next.hideModelSections !== false;
  applyPopupVisibility(provider || next?.defaults?.provider || 'local-whisper', hideToggle);
}

// normalizeHost: same normalization used elsewhere
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

  // Do NOT strip www. prefix

  return host;
}

// Updated loadState() — replace the existing function in popup.js with this version
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

  // Whisper select (backing) and Vosk inputs (backing + pretty display)
  const whisperSelect = document.getElementById('model');
  const voskInput = document.getElementById('vosk-model'); // real backing input
  const prettyVosk = document.getElementById('vosk-model-pretty-display'); // pretty visible input (if created)

  // Reset both controls first
  if (whisperSelect) whisperSelect.value = '';
  if (voskInput) voskInput.value = '';
  if (prettyVosk) prettyVosk.value = '';

  // Populate based on override (if present)
  if (o.model) {
    if (isVoskModel(o.model)) {
      if (voskInput) voskInput.value = o.model;
      // sync pretty display (if available)
      if (prettyVosk) {
        const pretty = window.VOSK_ID_TO_PRETTY?.get(o.model);
        prettyVosk.value = pretty || o.model;
      }
    } else {
      if (whisperSelect) whisperSelect.value = o.model;
      // ensure pretty display is cleared
      if (prettyVosk) prettyVosk.value = '';
      if (voskInput) voskInput.value = '';
    }
  } else {
    // No override model: ensure both are empty
    if (whisperSelect) whisperSelect.value = '';
    if (voskInput) voskInput.value = '';
    if (prettyVosk) prettyVosk.value = '';
  }

  // Update default dropdown labels visually
  const defaultProvider = settings?.defaults?.provider || 'vosk';
  const providerEl = document.getElementById('provider');
  const providerDefaultOpt = providerEl?.querySelector('option[value=""]');
  if (providerDefaultOpt) {
    const label = providerEl.querySelector(`option[value="${defaultProvider}"]`)?.textContent || defaultProvider;
    providerDefaultOpt.textContent = `Use default (${label.split('(')[0].trim()})`;
  }

  const defaultModel = settings?.defaults?.model || '';
  const modelEl = document.getElementById('model');
  const modelDefaultOpt = modelEl?.querySelector('option[value=""]');
  if (modelDefaultOpt) {
    let label = 'Unknown';
    if (defaultProvider === 'local-whisper') {
      label = modelEl.querySelector(`option[value="${defaultModel}"]`)?.textContent || defaultModel || 'Base English';
    } else if (defaultProvider === 'vosk') {
      label = window.VOSK_ID_TO_PRETTY?.get(defaultModel) || defaultModel || 'Default';
    } else {
      label = 'Server Managed';
    }
    modelDefaultOpt.textContent = `Use default (${label.split('(')[0].trim()})`;
  }

  const defaultGoogleMode = settings?.defaults?.googleServerMode || 'v1';
  const googleModeEl = document.getElementById('google-server-mode');
  const googleModeDefaultOpt = googleModeEl?.querySelector('option[value=""]');
  if (googleModeDefaultOpt) {
    const label = googleModeEl.querySelector(`option[value="${defaultGoogleMode}"]`)?.textContent || defaultGoogleMode;
    googleModeDefaultOpt.textContent = `Use default (${label.split('—')[0].trim()})`;
  }

  document.getElementById('language').value = o.language || '';
  document.getElementById('timeout').value = o.silenceTimeoutMs ?? '';
  document.getElementById('provider').value = provider;
  document.getElementById('grace-ms').value = o.graceMs ?? '';

  // Load Google Server Mode
  const googleServerModeEl = document.getElementById('google-server-mode');
  if (googleServerModeEl) googleServerModeEl.value = o.googleServerMode || '';

  const siteStatus = document.getElementById('site-status');
  if (siteStatus) siteStatus.value = (o.enabled === false) ? 'disabled' : '';

  const hideToggle = settings?.hideModelSections !== false;
  applyPopupVisibility(provider || settings?.defaults?.provider || 'local-whisper', hideToggle);
}

async function removeOverride() {
  const tab = await getActiveTab();
  let rawHost = '';
  try { rawHost = new URL(tab?.url || '').hostname; } catch { rawHost = ''; }
  const host = normalizeHost(rawHost);
  if (!host) return;

  const { settings } = await browser.storage.local.get('settings');
  const next = settings || {};
  next.overrides = next.overrides || {};

  // Find the actual key stored in overrides that corresponds to this host (exact or rule match).
  let targetKey = null;
  if (next.overrides[host]) {
    targetKey = host;
  } else {
    for (const k of Object.keys(next.overrides)) {
      const normalizedK = normalizeHost(k);
      if (!normalizedK) continue;
      if (host === normalizedK || host.endsWith('.' + normalizedK)) {
        targetKey = k;
        break;
      }
    }
  }

  if (!targetKey) return;

  delete next.overrides[targetKey];
  await browser.storage.local.set({ settings: next });
  notifySaved(t('popup_removed', 'Removed'));
  browser.runtime.sendMessage({ type: 'CONFIG_CHANGED' });

  // Reload popup UI after removal so inputs go empty
  await loadState();
}

function notifySaved(text = t('popup_status_saved', 'Saved')) {
  const s = document.getElementById('status');
  s.textContent = text;
  s.classList.add('show');
  setTimeout(() => s.classList.remove('show'), 1200);
}

['model', 'language', 'timeout', 'provider', 'site-status', 'grace-ms', 'google-server-mode'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  const evt = (id === 'timeout' || id === 'grace-ms' || id === 'language') ? 'input' : 'change';
  el.addEventListener(evt, () => {
    if (id === 'provider') {
      browser.storage.local.get('settings').then(({ settings }) => {
        applyPopupVisibility(el.value || settings?.defaults?.provider || 'local-whisper', settings?.hideModelSections !== false);
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