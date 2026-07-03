import { CLOUD_VIEW_PREFIX } from '../../types/asrProvider';

/**
 * 「引擎与模型」左栏视图 id 体系。
 *
 * 本地四视图为固定枚举（'sherpa' 是 FunASR · Qwen · FireRed 的 UI 合并组）；
 * 云端听写为逐条目平级入口，视图 id 形如 `cloud:<typeId>`（品牌/孤儿）、
 * `cloud:<typeId>:<presetId>`（预设槽位）、`cloud:<typeId>:i:<instanceId>`
 * （自定义实例），见 types/asrProvider 的 cloudViewId 家族 / buildCloudViews。
 * 纯模块（无 React / electron），供 EngineModelTab 与 test:engines 复用。
 */
export const LOCAL_ENGINE_VIEWS = [
  'builtin',
  'fasterWhisper',
  'sherpa',
  'localCli',
] as const;

export type LocalEngineView = (typeof LOCAL_ENGINE_VIEWS)[number];

/** 左栏视图 id：本地四视图 + 云服务商视图（cloud:<typeId>）。 */
export type EngineView = LocalEngineView | `cloud:${string}`;

/**
 * localStorage 选中态校验（宽进严出）：接受本地四视图、任意 `cloud:*`
 * （孤儿类型只有实例加载后才可知，先宽进、加载后由调用方收敛回落），
 * 以及历史遗留的 `'cloud'`（旧单一云入口，加载后经 resolveLegacyCloudView 迁移）。
 */
export function isEngineViewId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if ((LOCAL_ENGINE_VIEWS as readonly string[]).includes(value)) return true;
  if (value === 'cloud') return true;
  return (
    value.startsWith(CLOUD_VIEW_PREFIX) &&
    value.length > CLOUD_VIEW_PREFIX.length
  );
}
