// Whisper models for on-device voice input (quantised ONNX exports of OpenAI's MIT-licensed
// Whisper, by onnx-community). The browser downloads the chosen one from this server, never
// from a third party. Pinned revisions and SHA-256s: scripts/fetch-models.ts verifies them.

export type VoiceModelSize = 'tiny' | 'base';

export interface VoiceModel {
  /** Directory under MODELS_DIR and model id in the browser (includes the revision). */
  id: string;
  repo: string;
  revision: string;
  /** Approximate download for the browser, in MB. */
  sizeMb: number;
  files: Record<string, string>;
}

export const VOICE_MODELS: Record<VoiceModelSize, VoiceModel> = {
  base: {
    id: 'whisper-base-1846881b',
    repo: 'onnx-community/whisper-base',
    revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
    sizeMb: 79,
    files: {
      'config.json': 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b',
      'generation_config.json': '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0',
      'preprocessor_config.json': 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
      'tokenizer.json': '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
      'tokenizer_config.json': '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573',
      'onnx/encoder_model_quantized.onnx': '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46',
      'onnx/decoder_model_merged_quantized.onnx': 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b',
    },
  },
  tiny: {
    id: 'whisper-tiny-ff417702',
    repo: 'onnx-community/whisper-tiny',
    revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
    sizeMb: 43,
    files: {
      'config.json': '46aeea0a406afbeb563fc8e59ca10609203df4299af6a83f73752fef369efd2d',
      'generation_config.json': 'f5c67e5a4f7102f8cb4d058bc95da276bbc19eeec997267c3bb0f25ef68facd1',
      'preprocessor_config.json': 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
      'tokenizer.json': '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
      'tokenizer_config.json': '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce',
      'onnx/encoder_model_quantized.onnx': '2af4a414ca47aa30f61246017e5fe82b0a8d229281d1255ba666a2a7f6b84d19',
      'onnx/decoder_model_merged_quantized.onnx': '25e807a962b6349356d0ea5d0dfe530b7e5bf0e2a484aeca0359d03143faddd3',
    },
  },
};
