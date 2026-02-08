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
let currentModel = null;
let modelLoadPromise = null;

// Prefer WebGPU, fall back to WASM
let preferredBackend = 'webgpu'; // 'webgpu' | 'wasm'

// IMPORTANT: do not pretend we're on wasm before loading.
// null means "no model loaded yet in this worker instance"
let activeBackend = null; // 'webgpu' | 'wasm' | null

let webgpuProbe = {
  hasNavigatorGpu: false,
  adapterOk: false,
  deviceOk: false,
  error: null,
  lastChecked: 0
};

async function probeWebGPU(force = false) {
  const now = Date.now();
  if (!force && (now - webgpuProbe.lastChecked < 10_000)) return webgpuProbe;

  webgpuProbe = {
    hasNavigatorGpu: false,
    adapterOk: false,
    deviceOk: false,
    error: null,
    lastChecked: now
  };

  try {
    webgpuProbe.hasNavigatorGpu = typeof navigator !== 'undefined' && !!navigator.gpu;
    if (!webgpuProbe.hasNavigatorGpu) return webgpuProbe;

    const adapter = await navigator.gpu.requestAdapter();
    webgpuProbe.adapterOk = !!adapter;
    if (!adapter) {
      webgpuProbe.error = 'requestAdapter() returned null';
      return webgpuProbe;
    }

    const device = await adapter.requestDevice();
    webgpuProbe.deviceOk = !!device;
    if (!device) {
      webgpuProbe.error = 'requestDevice() returned null';
      return webgpuProbe;
    }

    try { device.destroy?.(); } catch (_) {}
    return webgpuProbe;
  } catch (e) {
    webgpuProbe.error = e?.message || String(e);
    return webgpuProbe;
  }
}

async function disposeCurrentModel() {
  if (transcriber?.dispose) {
    try { await transcriber.dispose(); } catch (_) { }
  }
  transcriber = null;
  currentModel = null;

  // keep activeBackend as-is; it describes last loaded backend in this worker instance
  // If you want: set to null here too.
  // activeBackend = null;
}

async function loadModelWithBackend(modelID, backend) {
  transcriber = await pipeline('automatic-speech-recognition', modelID, { device: backend });
  currentModel = modelID;
  activeBackend = backend;
}

async function loadModel(modelID) {
  const probe = await probeWebGPU(false);
  const canTryWebGPU =
    preferredBackend === 'webgpu' &&
    probe.hasNavigatorGpu &&
    probe.adapterOk &&
    probe.deviceOk;

  const backendsToTry = canTryWebGPU ? ['webgpu', 'wasm'] : ['wasm'];

  let lastErr = null;
  for (const backend of backendsToTry) {
    try {
      await loadModelWithBackend(modelID, backend);
      return;
    } catch (e) {
      lastErr = e;
      await disposeCurrentModel();
    }
  }
  throw lastErr || new Error('Failed to load model');
}

async function ensureModel(modelID) {
  const safeModel = ALLOWED_MODELS.has(modelID) ? modelID : 'Xenova/whisper-base';

  if (transcriber && currentModel === safeModel) {
    return { model: safeModel, cached: true, backend: activeBackend };
  }

  if (transcriber && currentModel !== safeModel) {
    await disposeCurrentModel();
  }

  if (modelLoadPromise) {
    await modelLoadPromise;
    if (transcriber && currentModel === safeModel) {
      return { model: safeModel, cached: true, backend: activeBackend };
    }
  }

  modelLoadPromise = (async () => {
    try {
      await loadModel(safeModel);
    } catch (err) {
      await disposeCurrentModel();
      if (safeModel !== 'Xenova/whisper-base') {
        await loadModel('Xenova/whisper-base');
      } else {
        throw err;
      }
    }
  })();

  try {
    await modelLoadPromise;
    return { model: currentModel, cached: false, backend: activeBackend };
  } finally {
    modelLoadPromise = null;
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const { id, type } = msg;
  const reply = (payload) => self.postMessage({ id, ...payload });

  try {
    if (type === 'PING') {
      const probe = await probeWebGPU(false);
      reply({
        ok: true,
        preferredBackend,
        activeBackend: activeBackend || 'unloaded',
        hasModelLoaded: !!transcriber,
        webgpu: probe
      });
      return;
    }

    if (type === 'PROBE_WEBGPU') {
      const probe = await probeWebGPU(true);
      reply({ ok: true, webgpu: probe });
      return;
    }

    if (type === 'DISPOSE_MODEL') {
      await disposeCurrentModel();
      reply({ ok: true });
      return;
    }

    if (type === 'ENSURE_MODEL') {
      const r = await ensureModel(msg.modelID);
      reply({ ok: true, model: r.model, cached: r.cached, backend: r.backend });
      return;
    }

    if (type === 'TRANSCRIBE_FLOAT32') {
      const { modelID, language, input } = msg;
      if (!input) throw new Error('Missing input');

      const float32 = (input instanceof Float32Array)
        ? input
        : (input?.buffer instanceof ArrayBuffer ? new Float32Array(input.buffer) : new Float32Array(input));

      const ensured = await ensureModel(modelID);
      if (!transcriber) throw new Error('Model not loaded');

      const isEnglishModel = (currentModel || '').endsWith('.en');
      const langToUse = isEnglishModel ? 'en' : (language && language !== 'auto' ? language : null);

      const output = await transcriber(float32, {
        chunk_length_s: 30,
        stride_length_s: 5,
        language: langToUse,
        task: 'transcribe',
        temperature: 0
      });

      reply({
        ok: true,
        text: (output?.text || '').trim(),
        model: ensured.model,
        cached: ensured.cached,
        backend: ensured.backend
      });
      return;
    }

    reply({ ok: false, error: `Unknown worker message type: ${type}` });
  } catch (e) {
    reply({ ok: false, error: e?.message || String(e) });
  }
};