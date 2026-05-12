import { generateImage as generateGeminiImage } from './gemini.js';
import { generateImage as generateOpenAIImage } from './openaiImage.js';
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  getImageModelLabel,
  getImageProvider,
  resolveImageModel,
} from './imageModels.js';

export {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  getImageModelLabel,
  getImageProvider,
  resolveImageModel,
};

export async function generateImage({ model, prompt, aspectRatio = '1:1', productImage = null, options = {} }) {
  const resolvedModel = resolveImageModel(model);
  const provider = getImageProvider(resolvedModel);
  const providerOptions = { ...options, imageModel: resolvedModel };

  if (provider === 'openai') {
    return generateOpenAIImage(prompt, aspectRatio, productImage, providerOptions);
  }
  return generateGeminiImage(prompt, aspectRatio, productImage, providerOptions);
}
