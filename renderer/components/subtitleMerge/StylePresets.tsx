/**
 * 预设样式选择组件。
 *
 * 每个预设渲染为「所见即所得」的效果卡片：深色缩略背景上用预设的真实样式
 * （复用 subtitleStyleToCSS，与预览降级路径同一套映射）渲染样例字，
 * 并以角标标注样式模式（描边/背景框），小白看一眼即可挑选。
 *
 * 「我的样式」：用户把当前微调结果存为命名预设（store 持久化），
 * 与系统预设同卡片形态展示，可删除；任务向导的合成样式选择共用这批预设。
 */

import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import { BookmarkPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  SubtitleStyle,
  UserStylePreset,
} from '../../../types/subtitleMerge';
import { STYLE_PRESETS } from './constants';
import { subtitleStyleToCSS } from './utils/styleUtils';

interface StylePresetsProps {
  activePresetId: string | null;
  onSelectPreset: (presetId: string) => void;
  disabled?: boolean;
  /** 用户保存的样式预设（我的样式）；不传则不渲染该区块（只读场景） */
  userPresets?: UserStylePreset[];
  /** 保存当前样式为我的样式（返回 null 表示失败） */
  onSaveStylePreset?: (name: string) => Promise<UserStylePreset | null>;
  onDeleteStylePreset?: (id: string) => Promise<boolean>;
}

/** 卡片内样例字相对完整样式的缩放系数（把 22-28px 字号缩到卡片可容纳的大小） */
const CHIP_SCALE = 0.55;

const SAMPLE_TEXT = '字幕 Aa';

/** 所见即所得预设卡片（系统/用户共用视觉）；额外角标/删除钮经 overlay 注入 */
function PresetCard({
  name,
  style,
  active,
  disabled,
  onSelect,
  overlay,
  modeLabel,
}: {
  name: string;
  style: SubtitleStyle;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
  overlay?: React.ReactNode;
  modeLabel: string;
}) {
  const chipStyle = subtitleStyleToCSS(style, CHIP_SCALE);
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group/preset relative cursor-pointer overflow-hidden rounded-md border text-left transition-colors ${
        active
          ? 'border-primary ring-1 ring-primary'
          : 'border-border hover:border-primary/50'
      } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
    >
      {/* 效果缩略图：深色渐变模拟视频画面，样例字用预设真实样式渲染 */}
      <div className="relative flex h-12 items-center justify-center bg-gradient-to-br from-zinc-600 to-zinc-900">
        <span style={chipStyle}>{SAMPLE_TEXT}</span>
        <span className="absolute right-1 top-1 rounded bg-black/50 px-1 text-[10px] leading-4 text-white/80">
          {modeLabel}
        </span>
        {overlay}
      </div>
      <div
        className={`truncate px-1.5 py-1 text-center text-xs ${
          active ? 'bg-primary/10 font-medium' : 'bg-muted/40'
        }`}
        title={name}
      >
        {name}
      </div>
    </div>
  );
}

export default function StylePresets({
  activePresetId,
  onSelectPreset,
  disabled = false,
  userPresets,
  onSaveStylePreset,
  onDeleteStylePreset,
}: StylePresetsProps) {
  const { t } = useTranslation('subtitleMerge');
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [saving, setSaving] = useState(false);

  const modeLabel = (style: SubtitleStyle) =>
    style.borderStyle === 3 ? t('presetModeBox') : t('presetModeOutline');

  const handleSave = async () => {
    const name = presetName.trim();
    if (!name || saving || !onSaveStylePreset) return;
    setSaving(true);
    try {
      const saved = await onSaveStylePreset(name);
      if (saved) {
        toast.success(t('presetSaved', { name }));
        setSaveDialogOpen(false);
        setPresetName('');
      } else {
        toast.error(t('presetSaveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (preset: UserStylePreset) => {
    if (!onDeleteStylePreset) return;
    const ok = await onDeleteStylePreset(preset.id);
    if (ok) toast.success(t('presetDeleted', { name: preset.name }));
  };

  return (
    <div className="space-y-2">
      <label className="label-caps">{t('presets')}</label>
      <div className="grid grid-cols-3 gap-2">
        {STYLE_PRESETS.map((preset) => (
          <PresetCard
            key={preset.id}
            name={t(preset.nameKey) || preset.name}
            style={preset.style}
            active={activePresetId === preset.id}
            disabled={disabled}
            onSelect={() => onSelectPreset(preset.id)}
            modeLabel={modeLabel(preset.style)}
          />
        ))}
      </div>

      {/* 我的样式：保存入口常驻，有预设时以同款卡片列出 */}
      {userPresets && (
        <>
          <div className="flex items-center justify-between pt-1">
            <label className="label-caps">{t('myPresets')}</label>
            {onSaveStylePreset && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[11px]"
                disabled={disabled}
                onClick={() => setSaveDialogOpen(true)}
              >
                <BookmarkPlus className="h-3 w-3" />
                {t('saveStyleAsPreset')}
              </Button>
            )}
          </div>
          {userPresets.length > 0 ? (
            <div className="grid grid-cols-3 gap-2">
              {userPresets.map((preset) => (
                <PresetCard
                  key={preset.id}
                  name={preset.name}
                  style={preset.style}
                  active={activePresetId === preset.id}
                  disabled={disabled}
                  onSelect={() => onSelectPreset(preset.id)}
                  modeLabel={modeLabel(preset.style)}
                  overlay={
                    onDeleteStylePreset ? (
                      <button
                        type="button"
                        aria-label={t('deletePreset')}
                        title={t('deletePreset')}
                        className="absolute left-1 top-1 rounded bg-black/50 p-0.5 text-white/80 opacity-0 transition-opacity hover:bg-black/70 hover:text-white group-hover/preset:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(preset);
                        }}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    ) : undefined
                  }
                />
              ))}
            </div>
          ) : (
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t('myPresetsEmpty')}
            </p>
          )}
        </>
      )}

      {/* 保存我的样式：命名对话框 */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('savePresetDialogTitle')}</DialogTitle>
            <DialogDescription>{t('savePresetDialogDesc')}</DialogDescription>
          </DialogHeader>
          <Input
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            placeholder={t('savePresetNamePlaceholder')}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSave();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              disabled={!presetName.trim() || saving}
              onClick={handleSave}
            >
              {t('savePresetConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
