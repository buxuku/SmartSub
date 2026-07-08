/**
 * Azure Speech TTS 的纯工具（无网络 / fs / electron），test:dubbing 单测覆盖。
 *
 * speedControl='ssml'：speed 折算为 SSML `<prosody rate>`，本文件负责
 * SSML 构造与 XML 转义；计费含 SSML 标记字符，speed≈1 时省略 prosody 元素省字符。
 */

/** Azure prosody rate 支持区间（官方文档：0.5–2 倍）。 */
export const AZURE_RATE_MIN = 0.5;
export const AZURE_RATE_MAX = 2.0;

/** XML 文本/属性转义（& < > " '）。 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 从 Neural 音色名推导 `xml:lang`（`zh-CN-XiaoxiaoNeural` → `zh-CN`）；
 * 非常规命名回落 en-US（lang 仅是提示，voice name 才决定实际发音人）。
 */
export function azureLangFromVoice(voice: string): string {
  const m = /^([a-z]{2,3}-[A-Za-z]{2,4})-/.exec(voice.trim());
  return m ? m[1] : 'en-US';
}

/**
 * speed（1=原速）→ prosody rate 百分比串（'+30%' / '-10%'）。
 * clamp 到 Azure 支持区间；≈1（折算后 0%）返回 null，调用方省略 prosody 元素。
 */
export function speedToAzureProsodyRate(
  speed: number | undefined,
): string | null {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return null;
  const clamped = Math.min(AZURE_RATE_MAX, Math.max(AZURE_RATE_MIN, s));
  const pct = Math.round((clamped - 1) * 100);
  if (pct === 0) return null;
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

/** 构造单段合成 SSML（文本已转义；speed≈1 不含 prosody 元素）。 */
export function buildAzureSsml(
  text: string,
  voice: string,
  speed?: number,
): string {
  const lang = azureLangFromVoice(voice);
  const rate = speedToAzureProsodyRate(speed);
  const body = rate
    ? `<prosody rate="${rate}">${escapeXml(text)}</prosody>`
    : escapeXml(text);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
    `<voice name="${escapeXml(voice.trim())}">${body}</voice>` +
    `</speak>`
  );
}

/**
 * Azure 门户「终结点」展示的是通用认知服务域名（`{region}.api.cognitive.*`），
 * 不是 TTS 合成端点（`{region}.tts.speech.*`）——用户照抄门户必 404，
 * 按 region 前缀自动改写到 TTS 域名（国际云与 21V 主权云各一条规则）。
 */
export function normalizeAzureHost(host: string): string {
  const intl = /^([a-z0-9-]+)\.api\.cognitive\.microsoft\.com$/i.exec(host);
  if (intl) return `${intl[1]}.tts.speech.microsoft.com`;
  const cn = /^([a-z0-9-]+)\.api\.cognitive\.azure\.cn$/i.exec(host);
  if (cn) return `${cn[1]}.tts.speech.azure.cn`;
  return host;
}

/**
 * 解析合成端点：endpoint 字段整体覆盖（世纪互联等主权云），否则由 region 拼接；
 * 门户「终结点」域名自动改写到 TTS 域名，路径统一补全 `/cognitiveservices/v1`
 * （用户粘贴裸域名或完整路径均可）。
 */
export function buildAzureEndpoint(
  region: string | undefined,
  endpoint?: string,
): string {
  const explicit = endpoint?.trim();
  if (explicit) {
    let parsed: URL;
    try {
      parsed = new URL(explicit);
    } catch {
      throw new Error(
        'Azure TTS: endpoint must start with http:// or https://',
      );
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(
        'Azure TTS: endpoint must start with http:// or https://',
      );
    }
    parsed.hostname = normalizeAzureHost(parsed.hostname);
    let path = parsed.pathname.replace(/\/+$/, '');
    if (!/\/cognitiveservices\/v1$/i.test(path)) {
      path = `${path}/cognitiveservices/v1`;
    }
    parsed.pathname = path;
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString();
  }
  const r = region?.trim();
  if (!r) throw new Error('Azure TTS: region is required');
  return `https://${r}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

/** 音色清单端点：与合成端点同源，路径换为 `/cognitiveservices/voices/list`。 */
export function buildAzureVoicesListURL(
  region: string | undefined,
  endpoint?: string,
): string {
  return buildAzureEndpoint(region, endpoint).replace(
    /\/cognitiveservices\/v1$/i,
    '/cognitiveservices/voices/list',
  );
}

/**
 * voices/list 响应 → [{id, name}]：id 取 ShortName（合成用 voice 名），
 * name 取本地化名 + locale（如「晓晓 (zh-CN)」）；坏条目跳过。
 */
export function mapAzureVoices(
  raw: unknown,
): Array<{ id: string; name: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const v of raw) {
    const id = String((v as { ShortName?: unknown })?.ShortName ?? '').trim();
    if (!id) continue;
    const local = String(
      (v as { LocalName?: unknown })?.LocalName ??
        (v as { DisplayName?: unknown })?.DisplayName ??
        '',
    ).trim();
    const locale = String((v as { Locale?: unknown })?.Locale ?? '').trim();
    const name = local ? (locale ? `${local} (${locale})` : local) : id;
    out.push({ id, name });
  }
  return out;
}
