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
let currentBackend = 'wasm';
let modelLoadPromise = null;

async function disposeCurrentModel() {
  if (transcriber?.dispose) {
    try { await transcriber.dispose(); } catch (_) { }
  }
  transcriber = null;
  currentModel = null;
}

async function loadModel(modelID) {
  transcriber = await pipeline('automatic-speech-recognition', modelID, { device: currentBackend });
  currentModel = modelID;
}

async function ensureModel(modelID) {
  const safeModel = ALLOWED_MODELS.has(modelID) ? modelID : 'Xenova/whisper-tiny';

  if (transcriber && currentModel === safeModel) return { model: safeModel, cached: true };

  if (transcriber && currentModel !== safeModel) {
    await disposeCurrentModel();
  }

  if (modelLoadPromise) {
    await modelLoadPromise;
    if (transcriber && currentModel === safeModel) return { model: safeModel, cached: true };
  }

  modelLoadPromise = (async () => {
    try {
      await loadModel(safeModel);
    } catch (err) {
      await disposeCurrentModel();
      if (safeModel !== 'Xenova/whisper-tiny') await loadModel('Xenova/whisper-tiny');
      else throw err;
    }
  })();

  try {
    await modelLoadPromise;
    return { model: currentModel, cached: false };
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
      reply({ ok: true });
      return;
    }

    if (type === 'DISPOSE_MODEL') {
      await disposeCurrentModel();
      reply({ ok: true });
      return;
    }

    if (type === 'ENSURE_MODEL') {
      const r = await ensureModel(msg.modelID);
      reply({ ok: true, model: r.model, cached: r.cached });
      return;
    }

    if (type === 'TRANSCRIBE_FLOAT32') {
      const { modelID, language, input } = msg;
      if (!input) throw new Error('Missing input');

      // input arrives as Float32Array (preferred) or buffer-like
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
        cached: ensured.cached
      });
      return;
    }

    reply({ ok: false, error: `Unknown worker message type: ${type}` });
  } catch (e) {
    reply({ ok: false, error: e?.message || String(e) });
  }
};