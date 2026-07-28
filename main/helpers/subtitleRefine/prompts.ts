/**
 * 断句遍提示词（design D3）：verbatim + `<br>` 插标协议。
 *
 * 约束与 few-shot 借鉴 VideoCaptioner 验证过的 split prompt 设计（原文不变、只插标、
 * 限长双维度），反馈轮把 validator 定位出的错误连同上一次输出一并回喂——
 * translator 接口是单轮的，这里用「嵌入上一次输出」模拟多轮反馈循环。
 */

import type { RefineLimits } from './types';

export function buildSegmentationSystemPrompt(limits: RefineLimits): string {
  return `You are a professional subtitle segmentation expert. Your task is to split continuous transcript text into subtitle-friendly segments by inserting <br> tags at natural semantic break points.

<rules>
1. Insert <br> at natural semantic boundaries (between clauses, sentences, or complete phrases). Prefer breaks that keep each segment a complete, readable unit of meaning.
2. Segment length limits:
   - CJK text (Chinese/Japanese/Korean): at most ${limits.cjkCharLimit} characters per segment
   - Latin text (English etc.): at most ${limits.latinWordLimit} words per segment
3. Never end a segment on a dangling connective, article or preposition (e.g. "就是", "the", "a", "of").
4. Numbers, names and fixed phrases must stay within one segment (e.g. "三十五天" must not be split).
5. Keep the original text EXACTLY unchanged: do NOT add, delete, reorder or replace any character. Only insert <br> tags.
6. Output the segmented text directly. No explanations, no markdown fences.
</rules>

<example>
Input: 我们在呃生产环境里面遇到了一个特别奇怪的问题就是每次到晚上八点左右整个服务的响应时间就会突然涨上去
Output: 我们在呃生产环境里面<br>遇到了一个特别奇怪的问题<br>就是每次到晚上八点左右<br>整个服务的响应时间就会突然涨上去
</example>

<example>
Input: so the first thing we did was add a cache layer in front of the database and that alone cut the response time by almost forty percent
Output: so the first thing we did<br>was add a cache layer<br>in front of the database<br>and that alone cut the response time<br>by almost forty percent
</example>`;
}

export function buildSegmentationUserPrompt(text: string): string {
  return `Insert <br> tags to segment the following text:\n${text}`;
}

export function buildSegmentationFeedbackPrompt(
  text: string,
  previousOutput: string,
  feedback: string,
): string {
  return `Insert <br> tags to segment the following text:
${text}

Your previous output was:
${previousOutput}

It has the following errors:
${feedback}

Fix the errors and output the COMPLETE corrected text with <br> tags (include ALL segments, not just the fixed ones). No explanation.`;
}
