import { Subtitle } from '../types';

export function parseSubtitles(data: string[]): Subtitle[] {
  const subtitles: Subtitle[] = [];
  let currentSubtitle: Subtitle | null = null;

  for (let i = 0; i < data.length; i++) {
    const line = data[i]?.trim();
    if (!line) continue;
    
    // 检查是否为字幕编号：纯数字且下一行包含 "-->" 或下一行为空但下下行包含 "-->"
    if (/^\d+$/.test(line) && (
        (i + 1 < data.length && data[i + 1]?.trim().includes('-->')) || 
        (i + 1 < data.length && !data[i + 1]?.trim() && i + 2 < data.length && data[i + 2]?.trim().includes('-->'))
      )) {
      if (currentSubtitle) {
        subtitles.push(currentSubtitle);
      }
      currentSubtitle = {
        id: line,
        startEndTime: '',
        content: [],
      };
    } else if (line.includes('-->')) {
      if (currentSubtitle) {
        currentSubtitle.startEndTime = line;
      }
    } else if (currentSubtitle) {
      currentSubtitle.content.push(line);
    }
  }

  if (currentSubtitle) {
    subtitles.push(currentSubtitle);
  }

  return subtitles;
}

export function formatSubtitleContent(subtitle: Subtitle): string {
  return `${subtitle.id}\n${subtitle.startEndTime}\n${subtitle.content.join('\n')}`;
}
