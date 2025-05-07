import { Subtitle } from '../types';

export function parseSubtitles(data: string[]): Subtitle[] {
  const subtitles: Subtitle[] = [];
  let currentSubtitle: Subtitle | null = null;

  for (let i = 0; i < data.length; i++) {
    const line = data[i]?.trim();
    if (!line) continue;

    if (/^\d+$/.test(line)) {
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
