export const SUBTITLE_OUTPUT_FORMATS = [
  'srt',
  'vtt',
  'ass',
  'lrc',
  'txt',
] as const;

export type SubtitleOutputFormat = (typeof SUBTITLE_OUTPUT_FORMATS)[number];

export interface SubtitleOutputConfig {
  subtitleOutputFormat?: unknown;
  subtitleOutputFormats?: unknown;
}

/** Prefer a timed primary file regardless of the order in which boxes were checked. */
export function resolveSubtitleOutputFormats(
  config?: SubtitleOutputConfig,
): SubtitleOutputFormat[] {
  const requested = config?.subtitleOutputFormats;
  const selected = Array.isArray(requested)
    ? SUBTITLE_OUTPUT_FORMATS.filter((format) => requested.includes(format))
    : [];
  if (selected.length) return selected;
  const legacy = SUBTITLE_OUTPUT_FORMATS.find(
    (format) => format === config?.subtitleOutputFormat,
  );
  return [legacy || 'srt'];
}

export interface SubtitleOutputFile {
  filePath: string;
  contentType: string;
}

export interface SubtitleOutputFiles {
  sourceSubtitleFiles?: string[];
  translatedSubtitleFiles?: string[];
  tempSrtFile?: string;
  /** Timed, possibly bilingual delivery retained for composition after lossy export. */
  tempFinalSubtitleFile?: string;
}

/** Preview and editing need the original time axis, not a lossy delivery file. */
export function getProofreadSourcePath(
  file: SubtitleOutputFiles & { srtFile?: string },
): string | undefined {
  return file.tempSrtFile || file.srtFile;
}

export function subtitleOutputFilesToSave(
  files: SubtitleOutputFiles,
  translateContent = 'onlyTranslate',
): SubtitleOutputFile[] {
  return [
    ...(Array.isArray(files.sourceSubtitleFiles)
      ? files.sourceSubtitleFiles
      : []
    )
      .filter((p) => typeof p === 'string' && p)
      .map((filePath) => ({
        filePath,
        contentType: 'source',
      })),
    ...(Array.isArray(files.translatedSubtitleFiles)
      ? files.translatedSubtitleFiles
      : []
    )
      .filter((p) => typeof p === 'string' && p)
      .map((filePath) => ({
        filePath,
        contentType: translateContent,
      })),
    ...(files.tempSrtFile
      ? [{ filePath: files.tempSrtFile, contentType: 'source' }]
      : []),
    ...(files.tempFinalSubtitleFile
      ? [
          {
            filePath: files.tempFinalSubtitleFile,
            contentType: translateContent,
          },
        ]
      : []),
  ];
}
