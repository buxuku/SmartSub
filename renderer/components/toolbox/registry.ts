import React from 'react';
import {
  FileCode2,
  Scissors,
  Music,
  FileSearch,
  Clock,
  Languages,
  Minimize2,
  Film,
  type LucideIcon,
} from 'lucide-react';
import type { ToolboxToolManifest, ToolboxToolId } from '../../../types/toolbox';

export interface ToolRegistryItem extends ToolboxToolManifest {
  iconComponent: LucideIcon;
}

export const TOOL_REGISTRY: ToolRegistryItem[] = [
  // --- 阶段一：核心高频 ---
  {
    id: 'subtitle-converter',
    nameKey: 'tools.subtitle-converter.name',
    descKey: 'tools.subtitle-converter.desc',
    category: 'subtitles',
    icon: 'FileCode2',
    iconComponent: FileCode2,
    badgeKey: 'badges.popular',
    phase: 1,
  },
  {
    id: 'video-trimmer',
    nameKey: 'tools.video-trimmer.name',
    descKey: 'tools.video-trimmer.desc',
    category: 'video',
    icon: 'Scissors',
    iconComponent: Scissors,
    badgeKey: 'badges.lossless',
    phase: 1,
  },

  // --- 阶段二：进阶音视频与字幕流 ---
  {
    id: 'audio-extractor',
    nameKey: 'tools.audio-extractor.name',
    descKey: 'tools.audio-extractor.desc',
    category: 'audio',
    icon: 'Music',
    iconComponent: Music,
    badgeKey: 'badges.popular',
    phase: 2,
  },
  {
    id: 'embedded-subtitles',
    nameKey: 'tools.embedded-subtitles.name',
    descKey: 'tools.embedded-subtitles.desc',
    category: 'subtitles',
    icon: 'FileSearch',
    iconComponent: FileSearch,
    phase: 2,
  },
  {
    id: 'subtitle-sync',
    nameKey: 'tools.subtitle-sync.name',
    descKey: 'tools.subtitle-sync.desc',
    category: 'subtitles',
    icon: 'Clock',
    iconComponent: Clock,
    phase: 2,
  },

  // --- 阶段三：创作延伸与轻量交付 ---
  {
    id: 'bilingual-subtitles',
    nameKey: 'tools.bilingual-subtitles.name',
    descKey: 'tools.bilingual-subtitles.desc',
    category: 'subtitles',
    icon: 'Languages',
    iconComponent: Languages,
    phase: 3,
  },
  {
    id: 'video-compressor',
    nameKey: 'tools.video-compressor.name',
    descKey: 'tools.video-compressor.desc',
    category: 'video',
    icon: 'Minimize2',
    iconComponent: Minimize2,
    phase: 3,
  },
  {
    id: 'video-to-gif',
    nameKey: 'tools.video-to-gif.name',
    descKey: 'tools.video-to-gif.desc',
    category: 'video',
    icon: 'Film',
    iconComponent: Film,
    phase: 3,
  },
];

export function getToolManifest(id: ToolboxToolId): ToolRegistryItem | undefined {
  return TOOL_REGISTRY.find((item) => item.id === id);
}
