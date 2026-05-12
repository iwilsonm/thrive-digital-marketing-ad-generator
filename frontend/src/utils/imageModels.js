export const DEFAULT_IMAGE_MODEL = 'nano-banana-2';

export const IMAGE_MODEL_OPTIONS = [
  {
    id: 'nano-banana-2',
    label: 'Nano Banana 2 (Gemini 3.1 Flash)',
    description: 'Faster Gemini generation with improved text rendering, up to 4K (current default).',
  },
  {
    id: 'nano-banana-pro',
    label: 'Nano Banana Pro (Gemini 3 Pro)',
    description: 'High-fidelity Gemini image generation.',
  },
  {
    id: 'gpt-image-2',
    label: 'GPT Image 2 (OpenAI)',
    description: 'OpenAI image generation with token-based cost tracking.',
  },
];

export function resolveImageModel(value) {
  if (value === 'gemini-3-pro') return 'nano-banana-pro';
  return IMAGE_MODEL_OPTIONS.some(option => option.id === value) ? value : DEFAULT_IMAGE_MODEL;
}

export function getImageModelDescription(value) {
  const resolved = resolveImageModel(value);
  return IMAGE_MODEL_OPTIONS.find(option => option.id === resolved)?.description || '';
}
