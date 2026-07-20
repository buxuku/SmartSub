/// <reference path="./test-globals.d.ts" />
/**
 * 统一存储根目录解析单元测试（openspec: unified-storage-root）。
 *
 * 覆盖：
 * - resolveStorageLocation 三级优先级与 source 判定、trim 判空语义
 * - STORAGE_SUBPATHS 逐引擎子路径映射（resolveModelRoot）
 * - resolveTempDir 三级优先级（自定义 > storageRoot/temp > 系统默认）
 * - containsCjk / validateStoragePath 正反例（中文/CJK 标点/全角/纯英文/西文变音符/空串）
 * - isFactoryDefaultGgmlPath 归一化判定（等于出厂默认删除、自定义保留）
 * - sanitizeStoragePathPatch CJK 兜底（路径键剔除、非路径键透传）
 */
import path from 'path';
import {
  resolveStorageLocation,
  resolveModelRoot,
  resolveTempDir,
  isFactoryDefaultGgmlPath,
  sanitizeStoragePathPatch,
  STORAGE_SUBPATHS,
  type StorageKind,
} from '../main/helpers/storagePaths';
import { containsCjk, validateStoragePath } from '../types/pathValidation';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, name: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) {
    passed++;
  } else {
    failed++;
    console.error(
      `✗ ${name}\n    expected: ${expectedJson}\n    actual:   ${actualJson}`,
    );
  }
}

const USER_DATA = path.join('/base', 'userData');
const ROOT = path.join('/vol', 'SmartSub');

function run(): void {
  // ==========================================================
  // resolveStorageLocation：三级优先级与 source（design D1/D3）
  // ==========================================================
  eq(
    resolveStorageLocation({
      override: '/custom/models',
      storageRoot: ROOT,
      subpath: ['whisper-models'],
      defaultBase: USER_DATA,
    }),
    { path: '/custom/models', source: 'override' },
    'resolve: override wins over storageRoot',
  );
  eq(
    resolveStorageLocation({
      override: undefined,
      storageRoot: ROOT,
      subpath: ['whisper-models'],
      defaultBase: USER_DATA,
    }),
    { path: path.join(ROOT, 'whisper-models'), source: 'storageRoot' },
    'resolve: storageRoot + subpath when no override',
  );
  eq(
    resolveStorageLocation({
      subpath: ['whisper-models'],
      defaultBase: USER_DATA,
    }),
    { path: path.join(USER_DATA, 'whisper-models'), source: 'default' },
    'resolve: default base fallback',
  );
  eq(
    resolveStorageLocation({
      override: '   ',
      storageRoot: '',
      subpath: ['models', 'funasr'],
      defaultBase: USER_DATA,
    }),
    { path: path.join(USER_DATA, 'models', 'funasr'), source: 'default' },
    'resolve: blank override + empty root treated as unset',
  );
  eq(
    resolveStorageLocation({
      override: '',
      storageRoot: `  ${ROOT}  `,
      subpath: ['temp'],
      defaultBase: USER_DATA,
    }),
    { path: path.join(ROOT, 'temp'), source: 'storageRoot' },
    'resolve: storageRoot trimmed before join',
  );

  // ==========================================================
  // STORAGE_SUBPATHS：逐引擎映射（design D2）
  // ==========================================================
  const expectedSubpaths: Record<StorageKind, string[]> = {
    ggml: ['whisper-models'],
    ct2: ['faster-whisper-models'],
    funasr: ['models', 'funasr'],
    qwen: ['models', 'qwen'],
    firered: ['models', 'firered'],
    tts: ['models', 'tts'],
  };
  (Object.keys(expectedSubpaths) as StorageKind[]).forEach((kind) => {
    eq(
      STORAGE_SUBPATHS[kind],
      expectedSubpaths[kind],
      `subpath: ${kind} matches legacy default layout`,
    );
    eq(
      resolveModelRoot(kind, { storageRoot: ROOT }, USER_DATA),
      {
        path: path.join(ROOT, ...expectedSubpaths[kind]),
        source: 'storageRoot',
      },
      `modelRoot: ${kind} follows storageRoot`,
    );
    eq(
      resolveModelRoot(kind, undefined, USER_DATA),
      {
        path: path.join(USER_DATA, ...expectedSubpaths[kind]),
        source: 'default',
      },
      `modelRoot: ${kind} default without settings`,
    );
  });
  eq(
    resolveModelRoot(
      'ct2',
      { fasterWhisperModelsPath: '/ct2/override', storageRoot: ROOT },
      USER_DATA,
    ),
    { path: '/ct2/override', source: 'override' },
    'modelRoot: ct2 override key mapped correctly',
  );
  eq(
    resolveModelRoot(
      'ggml',
      { modelsPath: '/ggml/override', storageRoot: ROOT },
      USER_DATA,
    ),
    { path: '/ggml/override', source: 'override' },
    'modelRoot: ggml override key mapped correctly',
  );

  // ==========================================================
  // resolveTempDir：三级优先级（design D5）
  // ==========================================================
  const SYS_TEMP = path.join('/sys', 'tmp');
  eq(
    resolveTempDir({
      useCustomTempDir: true,
      customTempDir: '/my/tmp',
      storageRoot: ROOT,
      systemTempDir: SYS_TEMP,
    }),
    { path: '/my/tmp', source: 'override' },
    'temp: explicit custom dir wins over storageRoot',
  );
  eq(
    resolveTempDir({
      useCustomTempDir: false,
      customTempDir: '/my/tmp',
      storageRoot: ROOT,
      systemTempDir: SYS_TEMP,
    }),
    { path: path.join(ROOT, 'temp'), source: 'storageRoot' },
    'temp: toggle off falls to storageRoot/temp',
  );
  eq(
    resolveTempDir({
      useCustomTempDir: true,
      customTempDir: '   ',
      storageRoot: ROOT,
      systemTempDir: SYS_TEMP,
    }),
    { path: path.join(ROOT, 'temp'), source: 'storageRoot' },
    'temp: blank custom dir ignored even when toggled on',
  );
  eq(
    resolveTempDir({ systemTempDir: SYS_TEMP }),
    { path: path.join(SYS_TEMP, 'whisper-subtitles'), source: 'default' },
    'temp: system default keeps whisper-subtitles subdir',
  );

  // ==========================================================
  // containsCjk / validateStoragePath（design D6）
  // ==========================================================
  eq(containsCjk('D:\\模型\\whisper'), true, 'cjk: chinese chars detected');
  eq(
    containsCjk('/Users/张三/Library'),
    true,
    'cjk: chinese username detected',
  );
  eq(containsCjk('D:\\models\\、test'), true, 'cjk: cjk punctuation detected');
  eq(containsCjk('D:\\ｍｏｄｅｌｓ'), true, 'cjk: fullwidth forms detected');
  eq(containsCjk('D:\\SmartSub\\models'), false, 'cjk: ascii path passes');
  eq(
    containsCjk('/home/Média/tôt'),
    false,
    'cjk: latin diacritics not blocked',
  );
  eq(containsCjk(''), false, 'cjk: empty string passes');
  eq(
    validateStoragePath('D:\\统一存储'),
    { ok: false, reason: 'cjk' },
    'validate: cjk path rejected with reason',
  );
  eq(
    validateStoragePath('D:\\SmartSub'),
    { ok: true },
    'validate: ascii path accepted',
  );

  // ==========================================================
  // isFactoryDefaultGgmlPath：归一化判定（design D4-2）
  // ==========================================================
  eq(
    isFactoryDefaultGgmlPath(path.join(USER_DATA, 'whisper-models'), USER_DATA),
    true,
    'normalize: factory default path detected',
  );
  eq(
    isFactoryDefaultGgmlPath('/custom/ggml', USER_DATA),
    false,
    'normalize: custom path preserved',
  );
  eq(
    isFactoryDefaultGgmlPath(undefined, USER_DATA),
    false,
    'normalize: missing key untouched',
  );
  eq(
    isFactoryDefaultGgmlPath('', USER_DATA),
    false,
    'normalize: empty string untouched',
  );

  // ==========================================================
  // sanitizeStoragePathPatch：CJK 兜底（design D6-2）
  // ==========================================================
  eq(
    sanitizeStoragePathPatch({
      storageRoot: 'D:\\模型',
      funasrModelsPath: 'D:\\语音',
      customTempDir: '/tmp/ok',
      language: '中文可以出现在非路径键',
    }),
    {
      sanitized: {
        customTempDir: '/tmp/ok',
        language: '中文可以出现在非路径键',
      },
      rejectedKeys: ['storageRoot', 'funasrModelsPath'],
    },
    'sanitize: cjk path keys dropped, non-path keys untouched',
  );
  eq(
    sanitizeStoragePathPatch({ storageRoot: 'D:\\SmartSub' }),
    { sanitized: { storageRoot: 'D:\\SmartSub' }, rejectedKeys: [] },
    'sanitize: ascii path keys pass through',
  );
  eq(
    sanitizeStoragePathPatch(undefined),
    { sanitized: {}, rejectedKeys: [] },
    'sanitize: undefined patch tolerated',
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
