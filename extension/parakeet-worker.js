/**
 * Parakeet ASR Worker
 *
 * Runs Nvidia Parakeet ONNX models in an isolated worker context
 * using parakeet.js (loaded from CDN).
 *
 * Includes Phase 1 Streaming Architecture:
 * - RingBuffer for contiguous audio storage
 * - AudioSegmentProcessor for energy-based VAD
 * - UtteranceBasedMerger for mature/immature state
 */

import { RingBuffer } from './parakeet-ringbuffer.js';
import { AudioSegmentProcessor } from './parakeet-vad.js';
import { UtteranceBasedMerger } from './parakeet-merger.js';
import { normalizeParakeetConfig } from './parakeet-config.js';
let parakeetModule = null;

async function getParakeetModule() {
  if (parakeetModule) return parakeetModule;

  const MAX_RETRIES = 3;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      parakeetModule = await import('https://esm.run/parakeet.js@1');
      return parakeetModule;
    } catch (e) {
      lastErr = e;
      parakeetModule = null;
      if (attempt < MAX_RETRIES - 1) {
        const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr || new Error('Failed to import parakeet.js after retries');
}

const ALLOWED_MODELS = new Set([
  'parakeet-tdt-0.6b-v2',
  'parakeet-tdt-0.6b-v3'
]);

const DEFAULT_MODEL = 'parakeet-tdt-0.6b-v3';

let model = null;
let currentModelId = null;
let modelLoadPromise = null;
const transcribers = new Map();

function getUsableChunkText(chunkText) {
  if (!chunkText) return '';
  let text = chunkText.trim();
  if (!text) return '';
  const words = text.match(/[a-zA-Z\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF]{2,}/g);
  if (!words || words.length === 0) return '';
  return text;
}

// Prefer WebGPU, fall back to WASM
let preferredBackend = 'webgpu';
let activeBackend = null;

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

    try { device.destroy?.(); } catch (_) { }
    return webgpuProbe;
  } catch (e) {
    webgpuProbe.error = e?.message || String(e);
    return webgpuProbe;
  }
}

async function disposeCurrentModel() {
  for (const t of transcribers.values()) {
    try { t.reset(); } catch (_) {}
  }
  transcribers.clear();
  model = null;
  currentModelId = null;
}

async function loadModelWithBackend(modelId, backend, config) {
  const pk = await getParakeetModule();
  const parakeetConfig = normalizeParakeetConfig(config);
  model = await pk.fromHub(modelId, {
    backend: backend,
    encoderQuant: parakeetConfig.encoderQuant,
    decoderQuant: parakeetConfig.decoderQuant,
    cpuThreads: parakeetConfig.wasmThreads,
    preprocessorBackend: 'js'
  });
  currentModelId = modelId;
  activeBackend = backend;
}

async function loadModel(modelId, config) {
  const parakeetConfig = normalizeParakeetConfig(config);
  const probe = await probeWebGPU(false);
  const canTryWebGPU =
    parakeetConfig.backendMode === 'webgpu-hybrid' &&
    probe.hasNavigatorGpu &&
    probe.adapterOk &&
    probe.deviceOk;

  const backendsToTry = canTryWebGPU ? ['webgpu', 'wasm'] : ['wasm'];

  let lastErr = null;
  for (const backend of backendsToTry) {
    try {
      await loadModelWithBackend(modelId, backend, config);
      return;
    } catch (e) {
      lastErr = e;
      await disposeCurrentModel();
    }
  }
  throw lastErr || new Error('Failed to load Parakeet model');
}

async function ensureModel(modelId, config) {
  const safeModel = ALLOWED_MODELS.has(modelId) ? modelId : DEFAULT_MODEL;

  if (model && currentModelId === safeModel) {
    return { model: safeModel, cached: true, backend: activeBackend };
  }

  if (model && currentModelId !== safeModel) {
    await disposeCurrentModel();
  }

  if (modelLoadPromise) {
    await modelLoadPromise;
    if (model && currentModelId === safeModel) {
      return { model: safeModel, cached: true, backend: activeBackend };
    }
  }

  modelLoadPromise = (async () => {
    try {
      await loadModel(safeModel, config);
    } catch (err) {
      await disposeCurrentModel();
      if (safeModel !== DEFAULT_MODEL) {
        await loadModel(DEFAULT_MODEL, config);
      } else {
        throw err;
      }
    }
  })();

  try {
    await modelLoadPromise;
    return { model: currentModelId, cached: false, backend: activeBackend };
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
        hasModelLoaded: !!model,
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
      const r = await ensureModel(msg.modelID, msg.config);
      reply({ ok: true, model: r.model, cached: r.cached, backend: r.backend });
      return;
    }

    if (type === 'TRANSCRIBE_FLOAT32') {
      const { modelID, input, config } = msg;
      if (!input) throw new Error('Missing input');

      const float32 = (input instanceof Float32Array)
        ? input
        : (input?.buffer instanceof ArrayBuffer ? new Float32Array(input.buffer) : new Float32Array(input));

      const ensured = await ensureModel(modelID, config);
      if (!model) throw new Error('Parakeet model not loaded');

      const output = await model.transcribe(float32, 16000, {
        returnTimestamps: false,
        returnConfidences: false
      });

      const text = (output?.utterance_text || '').trim();

      reply({
        ok: true,
        text,
        model: ensured.model,
        cached: ensured.cached,
        backend: ensured.backend
      });
      return;
    }

    if (type === 'TRANSCRIBE_STREAM_START') {
      const { modelID, sessionId, config, encoderQuant, decoderQuant, inferenceInterval, vadThreshold } = msg;
      const updatedConfig = normalizeParakeetConfig({
        ...(config || {}),
        ...(encoderQuant ? { encoderQuant } : {}),
        ...(decoderQuant ? { decoderQuant } : {}),
        ...(inferenceInterval ? { inferenceIntervalMs: inferenceInterval } : {}),
        ...(vadThreshold ? { energyThreshold: vadThreshold } : {})
      });

      await ensureModel(modelID, updatedConfig);
      if (!model) throw new Error('Parakeet model not loaded');
      
      transcribers.set(sessionId, {
        buffer: new RingBuffer(16000, 60), // 60s max context
        vad: new AudioSegmentProcessor({
            energyThreshold: updatedConfig.energyThreshold
        }),
        merger: new UtteranceBasedMerger(),
        lastInferenceFrame: 0,
        matureCursorFrame: 0,
        inferenceIntervalFrames: Math.floor(16000 * (updatedConfig.inferenceIntervalMs / 1000)),
        processing: false
      });
      reply({ ok: true });
      return;
    }

    if (type === 'TRANSCRIBE_STREAM_CHUNK') {
      const { sessionId, input } = msg;
      const session = transcribers.get(sessionId);
      if (!session) throw new Error('No session found for ' + sessionId);
      
      const float32 = (input instanceof Float32Array)
        ? input
        : (input?.buffer instanceof ArrayBuffer ? new Float32Array(input.buffer) : new Float32Array(input));

      session.buffer.write(float32);
      const currentTime = session.buffer.getCurrentTime();

      let sumSq = 0;
      for (let i = 0; i < float32.length; i++) sumSq += float32[i] * float32[i];
      const energy = Math.sqrt(sumSq / float32.length);

      const segments = session.vad.processAudioData(float32, currentTime, energy);
      const isSpeech = session.vad.getStateInfo().inSpeech;
      const currentFrame = session.buffer.getCurrentFrame();

      if (segments.length > 0) {
          // A segment boundary was returned by VAD (either silence, or max duration reached).
          session.merger.commitCurrentWindow();
          session.matureCursorFrame = currentFrame;
      }

      const framesSinceInference = currentFrame - session.lastInferenceFrame;

      if (framesSinceInference >= session.inferenceIntervalFrames && !session.processing) {
          session.processing = true;
          try {
              // 1. We transcribe from the mature cursor to the current head
              const windowAudio = session.buffer.read(session.matureCursorFrame, currentFrame);

              if (windowAudio.length >= 16000 * 0.2) { // At least 200ms
                  const result = await model.transcribe(windowAudio, 16000, {
                      returnTimestamps: false,
                      returnConfidences: false
                  });

                  const utteranceText = (result?.utterance_text || '').trim();
                  
                  if (utteranceText && getUsableChunkText(utteranceText)) {
                      session.merger.process(utteranceText);
                  }
              }

              session.lastInferenceFrame = currentFrame;

              reply({ 
                  ok: true, 
                  matureText: session.merger.getMature(),
                  immatureText: session.merger.getImmature(),
                  isSpeech
              });
          } catch (e) {
              reply({ ok: false, error: e?.message || String(e) });
          } finally {
              session.processing = false;
          }
      } else {
          reply({ ok: true, matureText: session.merger.getMature(), immatureText: session.merger.getImmature(), isSpeech });
      }
      return;
    }

    if (type === 'TRANSCRIBE_STREAM_STOP') {
      const { sessionId } = msg;
      const session = transcribers.get(sessionId);
      if (session) {
        // We do not do a massive retranscription here, we trust the pipeline
        session.merger.forceFinalize();
        transcribers.delete(sessionId);
        reply({ ok: true, finalText: session.merger.getMature().trim() });
      } else {
        reply({ ok: true, finalText: '' });
      }
      return;
    }

    reply({ ok: false, error: `Unknown worker message type: ${type}` });
  } catch (e) {
    reply({ ok: false, error: e?.message || String(e) });
  }
};
