/** Only credential values are live. Result-affecting parameters are frozen. */
const secretKey =
  /^(apiKey|api_key|apiSecret|accessKey|accessKeyId|accessKeySecret|secretId|secretKey|appId|appKey|accessToken|refreshToken|token|password|authorization|x-api-key)$/i;
export function redactCredentials(value: any): any {
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretKey.test(key) ? { $credential: true } : redactCredentials(item),
      ]),
    );
  return value;
}
export function resolveCredentials(snapshot: any, live: any): any {
  if (snapshot?.$credential === true)
    return typeof live === 'string' || typeof live === 'number' ? live : '';
  if (Array.isArray(snapshot))
    return snapshot.map((item, index) =>
      resolveCredentials(
        item,
        item?.id
          ? live?.find((candidate: any) => candidate.id === item.id)
          : live?.[index],
      ),
    );
  if (snapshot && typeof snapshot === 'object')
    return Object.fromEntries(
      Object.entries(snapshot).map(([key, item]) => [
        key,
        // Older manifests may contain credentials captured before this key was recognized.
        resolveCredentials(
          secretKey.test(key) ? { $credential: true } : item,
          live?.[key],
        ),
      ]),
    );
  return snapshot;
}
export const SNAPSHOT_STORE_KEYS = [
  'settings',
  'translationProviders',
  'asrProviders',
  'ttsProviders',
  'clonedVoices',
  'mergePreferences',
  'mergeStylePresets',
  'glossaries',
  'userConfig',
] as const;
export function captureEffectiveConfiguration(
  read: (key: string) => any,
  providerParameters: Record<string, any>,
) {
  return redactCredentials({
    ...Object.fromEntries(
      SNAPSHOT_STORE_KEYS.map((key) => [
        key,
        read(key) ??
          (key.endsWith('Providers') || key === 'glossaries' ? [] : {}),
      ]),
    ),
    providerParameters,
  });
}
