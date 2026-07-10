/**
 * 预设样式选择组件。
 *
 * 每个预设渲染为「所见即所得」的效果卡片：深色缩略背景上用预设的真实样式
 * （复用 subtitleStyleToCSS，与预览降级路径同一套映射）渲染样例字，
 * 并以角标标注样式模式（描边/背景框），小白看一眼即可挑选。
 */

import React from 'react';
import { useTranslation } from 'next-i18next';
import { STYLE_PRESETS } from './constants';
import { subtitleStyleToCSS } from './utils/styleUtils';

interface StylePresetsProps {
  activePresetId: string | null;
  onSelectPreset: (presetId: string) => void;
  disabled?: boolean;
}

/** 卡片内样例字相对完整样式的缩放系数（把 22-28px 字号缩到卡片可容纳的大小） */
const CHIP_SCALE = 0.55;

const SAMPLE_TEXT = '字幕 Aa';

export default function StylePresets({
  activePresetId,
  onSelectPreset,
  disabled = false,
}: StylePresetsProps) {
  const { t } = useTranslation('subtitleMerge');

  return (
    <div className="space-y-2">
      <label className="label-caps">{t('presets')}</label>
      <div className="grid grid-cols-3 gap-2">
        {STYLE_PRESETS.map((preset) => {
          const active = activePresetId === preset.id;
          const isBoxMode = preset.style.borderStyle === 3;
          const chipStyle = subtitleStyleToCSS(preset.style, CHIP_SCALE);
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onSelectPreset(preset.id)}
              disabled={disabled}
              className={`overflow-hidden rounded-md border text-left transition-colors disabled:opacity-50 ${
                active
                  ? 'border-primary ring-1 ring-primary'
                  : 'border-border hover:border-primary/50'
              }`}
            >
              {/* 效果缩略图：深色渐变模拟视频画面，样例字用预设真实样式渲染 */}
              <div className="relative flex h-12 items-center justify-center bg-gradient-to-br from-zinc-600 to-zinc-900">
                <span style={chipStyle}>{SAMPLE_TEXT}</span>
                <span className="absolute right-1 top-1 rounded bg-black/50 px-1 text-[10px] leading-4 text-white/80">
                  {isBoxMode ? t('presetModeBox') : t('presetModeOutline')}
                </span>
              </div>
              <div
                className={`truncate px-1.5 py-1 text-center text-xs ${
                  active ? 'bg-primary/10 font-medium' : 'bg-muted/40'
                }`}
              >
                {t(preset.nameKey) || preset.name}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
