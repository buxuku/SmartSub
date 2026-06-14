import type { RemoteEngineManifest } from '../../../types/engine';

/**
 * app 支持的 sidecar 协议大版本区间（含端点）。
 * 引擎独立发版后，凭此判断"老 app + 新引擎"是否兼容；改协议须升上游
 * PROTOCOL_VERSION 并同步这里的 MAX。
 */
export const SUPPORTED_PROTOCOL_MIN = 1;
export const SUPPORTED_PROTOCOL_MAX = 1;

export function isProtocolSupported(
  version: number | undefined | null,
): boolean {
  return (
    typeof version === 'number' &&
    version >= SUPPORTED_PROTOCOL_MIN &&
    version <= SUPPORTED_PROTOCOL_MAX
  );
}

/**
 * 远端 manifest 是否可安装。
 * 老 release 无 manifest 或无 protocolVersion 时放行（向后兼容）；
 * 有则按区间判定。
 */
export function isRemoteProtocolInstallable(
  remote: RemoteEngineManifest | null,
): boolean {
  if (!remote || typeof remote.protocolVersion !== 'number') return true;
  return isProtocolSupported(remote.protocolVersion);
}
