export const DEFAULT_IMAGE_MODEL = 'nano-banana-2';

export const IMAGE_MODELS = [
  { id: 'nano-banana-2', label: 'Nano Banana 2 (Gemini 3.1 Flash)', provider: 'gemini' },
  { id: 'nano-banana-pro', label: 'Nano Banana Pro (Gemini 3 Pro)', provider: 'gemini' },
  { id: 'gpt-image-2', label: 'GPT Image 2 (OpenAI)', provider: 'openai' },
];

const LEGACY_ALIASES = {
  'gemini-3-pro': 'nano-banana-pro',
};

const MODEL_BY_ID = new Map(IMAGE_MODELS.map(model => [model.id, model]));

export function resolveImageModel(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return DEFAULT_IMAGE_MODEL;
  const aliased = LEGACY_ALIASES[raw] || raw;
  return MODEL_BY_ID.has(aliased) ? aliased : DEFAULT_IMAGE_MODEL;
}

export function getImageProvider(modelId) {
  const resolved = resolveImageModel(modelId);
  return MODEL_BY_ID.get(resolved)?.provider || 'gemini';
}

export function getImageModelLabel(modelId) {
  const resolved = resolveImageModel(modelId);
  return MODEL_BY_ID.get(resolved)?.label || MODEL_BY_ID.get(DEFAULT_IMAGE_MODEL).label;
}

export function getImageModel(modelId) {
  const resolved = resolveImageModel(modelId);
  return MODEL_BY_ID.get(resolved) || MODEL_BY_ID.get(DEFAULT_IMAGE_MODEL);
}
