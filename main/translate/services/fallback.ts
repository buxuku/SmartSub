import { TranslatorFunction } from '../types';
import { logMessage } from '../../helpers/storeManager';
import {
  bingFreeTranslator,
  googleFreeTranslator,
  deeplxTranslator,
} from '../../service';
import {
  isTaskCancelledError,
  throwIfSignalCancelled,
} from '../../helpers/taskContext';
import type { TranslationRequestOptions } from '../types';

/**
 * 多源失败自动回退编排。
 *
 * 按可配置的有序回退链依次尝试免费源，单源失败/限流自动切换到下一源，
 * 仅当链中所有源都失败时才判定该批失败（交由上层批级重试/降级处理）。
 * 不可用的源（如缺少端点的 deeplx）会被跳过而不计为失败。
 *
 * 注意：直接引用具体免费源以避免与 translationProvider 形成循环依赖。
 */

const SOURCE_MAP: Record<string, TranslatorFunction> = {
  bingFree: bingFreeTranslator as unknown as TranslatorFunction,
  googleFree: googleFreeTranslator as unknown as TranslatorFunction,
  deeplx: deeplxTranslator as unknown as TranslatorFunction,
};

function parseChain(chainRaw: unknown, defaultChain: string[]): string[] {
  if (typeof chainRaw === 'string' && chainRaw.trim()) {
    return chainRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(chainRaw) && chainRaw.length > 0) {
    return chainRaw.map((s) => String(s).trim()).filter(Boolean);
  }
  return defaultChain;
}

/** 判断某源在当前配置下是否可用（不可用则跳过，不计失败） */
function isSourceUnavailable(sourceId: string, proof: any): string | null {
  if (sourceId === 'deeplx' && !proof?.apiUrl) {
    return 'no endpoint';
  }
  return null;
}

export function createFallbackTranslator(
  defaultChain: string[],
): TranslatorFunction {
  return async function fallbackTranslate(
    query: string[],
    proof: any,
    sourceLanguage: string,
    targetLanguage: string,
    options?: TranslationRequestOptions,
  ): Promise<any> {
    throwIfSignalCancelled(options?.signal);
    const list = Array.isArray(query) ? query : [query];
    const chain = parseChain(proof?.fallbackChain, defaultChain);
    const errors: string[] = [];

    for (const sourceId of chain) {
      throwIfSignalCancelled(options?.signal);
      if (sourceId === 'autoFree') continue; // 防止递归
      const translator = SOURCE_MAP[sourceId];
      if (!translator) {
        errors.push(`${sourceId}: not a supported free source`);
        continue;
      }

      const unavailable = isSourceUnavailable(sourceId, proof);
      if (unavailable) {
        logMessage(`autoFree skip ${sourceId}: ${unavailable}`, 'info');
        errors.push(`${sourceId}: ${unavailable}`);
        continue;
      }

      try {
        logMessage(`autoFree trying source: ${sourceId}`, 'info');
        const res = await translator(
          list,
          { ...proof, id: sourceId },
          sourceLanguage,
          targetLanguage,
          options,
        );
        throwIfSignalCancelled(options?.signal);
        const arr = Array.isArray(res) ? res : [res];
        // 校验：长度对齐且非全空
        const aligned = arr.length === list.length;
        const hasContent = arr.some((t) => t && String(t).trim());
        if (aligned && hasContent) {
          if (sourceId !== chain[0]) {
            logMessage(`autoFree fell back to ${sourceId}`, 'info');
          }
          return Array.isArray(query) ? arr : arr[0];
        }
        errors.push(`${sourceId}: invalid result (aligned=${aligned})`);
      } catch (error: any) {
        if (isTaskCancelledError(error)) throw error;
        throwIfSignalCancelled(options?.signal);
        const msg = error?.message || 'error';
        errors.push(`${sourceId}: ${msg}`);
        logMessage(`autoFree source ${sourceId} failed: ${msg}`, 'warning');
      }
    }

    // 全部源失败：抛出带 (network) 的错误，避免被判为配置错误而中止整个任务
    throw new Error(
      `All free translation sources failed (network): ${errors.join(' | ')}`,
    );
  };
}
