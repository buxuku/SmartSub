import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { getTempDir } from './fileUtils';
import { logMessage } from './storeManager';
import {
  TTS_MODELS,
  TtsModelId,
  isTtsModelInstalled,
  getTtsModelRequest,
} from './ttsModelCatalog';
import { getSherpaTtsRuntime } from './sherpaOnnx/ttsRuntime';
import { encodeWav } from './audioProcessor';

export { encodeWav };

/** 试听短句：中英各一，按模型语言能力选择。 */
const AUDITION_TEXT_ZH = '你好，这是当前音色的试听效果。';
const AUDITION_TEXT_EN = 'Hello, this is a preview of the selected voice.';

/**
 * 音色试听 IPC：合成固定短句 → 写临时 wav → 返回绝对路径
 * （渲染层经 media:// 协议播放）。同 sid 结果按 (model,sid) 缓存于临时目录。
 */
export function setupTtsAudition(): void {
  ipcMain.handle(
    'auditionTtsVoice',
    async (
      _event,
      { model, sid }: { model: TtsModelId; sid: number },
    ): Promise<{ success: boolean; file?: string; error?: string }> => {
      try {
        const spec = TTS_MODELS[model];
        if (!spec) return { success: false, error: 'unknownModel' };
        if (!isTtsModelInstalled(model)) {
          return { success: false, error: 'modelNotInstalled' };
        }

        const outFile = path.join(
          getTempDir(),
          `tts-audition-${model}-${sid}.wav`,
        );
        if (fs.existsSync(outFile)) return { success: true, file: outFile };

        const text = spec.meta.languages.includes('zh')
          ? AUDITION_TEXT_ZH
          : AUDITION_TEXT_EN;
        const runtime = getSherpaTtsRuntime();
        const req = getTtsModelRequest(model);
        const { result } = runtime.synthesize(req, text, sid, 1.0);
        const audio = await result;

        fs.writeFileSync(outFile, encodeWav(audio.samples, audio.sampleRate));
        return { success: true, file: outFile };
      } catch (error) {
        logMessage(`tts audition error: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );
}
