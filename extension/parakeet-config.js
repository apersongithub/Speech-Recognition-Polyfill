const PARAKEET_MODEL_IDS = [
  'parakeet-tdt-0.6b-v2',
  'parakeet-tdt-0.6b-v3'
];

const PARAKEET_QUANTIZATION_MODES = ['int8', 'fp16', 'fp32'];
const PARAKEET_BACKEND_MODES = ['webgpu-hybrid', 'wasm'];

const PARAKEET_DEFAULTS = Object.freeze({
  streamingEnabled: true,
  prewarmEnabled: false,
  modelId: 'parakeet-tdt-0.6b-v3',
  backendMode: 'webgpu-hybrid',
  encoderQuant: 'int8',
  decoderQuant: 'int8',
  inferenceIntervalMs: 480,
  silenceFlushSec: 1.0,
  energyThreshold: 0.08,
  tenVadThreshold: 0.5,
  frameStride: 1,
  wasmThreads: 4
});

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampInteger(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeParakeetConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};

  return {
    streamingEnabled: source.streamingEnabled !== false,
    prewarmEnabled: source.prewarmEnabled === true,
    modelId: oneOf(source.modelId, PARAKEET_MODEL_IDS, PARAKEET_DEFAULTS.modelId),
    backendMode: oneOf(source.backendMode, PARAKEET_BACKEND_MODES, PARAKEET_DEFAULTS.backendMode),
    encoderQuant: oneOf(source.encoderQuant, PARAKEET_QUANTIZATION_MODES, PARAKEET_DEFAULTS.encoderQuant),
    decoderQuant: oneOf(source.decoderQuant, PARAKEET_QUANTIZATION_MODES, PARAKEET_DEFAULTS.decoderQuant),
    inferenceIntervalMs: clampInteger(source.inferenceIntervalMs, 200, 8000, PARAKEET_DEFAULTS.inferenceIntervalMs),
    silenceFlushSec: clampNumber(source.silenceFlushSec, 0.2, 5, PARAKEET_DEFAULTS.silenceFlushSec),
    energyThreshold: clampNumber(source.energyThreshold, 0.01, 0.5, PARAKEET_DEFAULTS.energyThreshold),
    tenVadThreshold: clampNumber(source.tenVadThreshold, 0.1, 0.95, PARAKEET_DEFAULTS.tenVadThreshold),
    frameStride: clampInteger(source.frameStride, 1, 4, PARAKEET_DEFAULTS.frameStride),
    wasmThreads: clampInteger(source.wasmThreads, 1, 16, PARAKEET_DEFAULTS.wasmThreads)
  };
}

function readParakeetConfig(settings = {}) {
  const defaults = settings?.defaults || {};
  const nested = defaults.parakeet || settings.parakeet || {};

  return normalizeParakeetConfig({
    streamingEnabled: settings.parakeetStreamingEnabled,
    prewarmEnabled: settings.parakeetPrewarmEnabled,
    modelId: defaults.parakeetModel,
    encoderQuant: defaults.parakeetEncoderQuant,
    decoderQuant: defaults.parakeetDecoderQuant,
    inferenceIntervalMs: defaults.parakeetInferenceInterval,
    energyThreshold: defaults.parakeetVadThreshold,
    ...nested
  });
}

function applyParakeetConfig(settings, config) {
  const target = settings && typeof settings === 'object' ? settings : {};
  const normalized = normalizeParakeetConfig(config);
  target.defaults = target.defaults || {};
  target.defaults.parakeet = normalized;

  // Legacy mirrors keep older code paths and exported settings readable while
  // the runtime moves to the nested schema.
  target.defaults.parakeetModel = normalized.modelId;
  target.defaults.parakeetEncoderQuant = normalized.encoderQuant;
  target.defaults.parakeetDecoderQuant = normalized.decoderQuant;
  target.defaults.parakeetInferenceInterval = normalized.inferenceIntervalMs;
  target.defaults.parakeetVadThreshold = normalized.energyThreshold;
  target.parakeetStreamingEnabled = normalized.streamingEnabled;
  target.parakeetPrewarmEnabled = normalized.prewarmEnabled;

  return target;
}

export {
  PARAKEET_BACKEND_MODES,
  PARAKEET_DEFAULTS,
  PARAKEET_MODEL_IDS,
  PARAKEET_QUANTIZATION_MODES,
  applyParakeetConfig,
  normalizeParakeetConfig,
  readParakeetConfig
};
