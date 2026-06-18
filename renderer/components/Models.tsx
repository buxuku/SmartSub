import React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslation } from 'next-i18next';
import {
  decodeEngineModel,
  encodeEngineModel,
  getEngineModelGroups,
} from 'lib/engineModels';
import type { EngineStatus, TranscriptionEngine } from '../../types/engine';

interface IProps {
  modelsInstalled?: string[];
  fasterWhisperModelsInstalled?: string[];
  funasrVadInstalled?: boolean;
  funasrAsrModelsInstalled?: string[];
  /** faster-whisper 运行时状态（用于过滤未装引擎的模型，state==='ready' 方可选） */
  pythonEngineStatus?: EngineStatus;
  /** funasr 运行库是否已安装（用于过滤未装引擎的模型） */
  funasrEngineInstalled?: boolean;
  /** qwen 共享 silero VAD 是否就绪 */
  qwenVadInstalled?: boolean;
  /** qwen 已安装模型 id 列表 */
  qwenModelsInstalled?: string[];
  /** qwen 运行库（与 funasr 同库）是否已安装 */
  qwenEngineInstalled?: boolean;
  /** fireRed 共享 silero VAD 是否就绪 */
  fireRedVadInstalled?: boolean;
  /** fireRed 已安装模型 id 列表 */
  fireRedModelsInstalled?: string[];
  /** fireRed 运行库（与 funasr 同库）是否已安装 */
  fireRedEngineInstalled?: boolean;
  /** 是否把 localCli 作为独立分组列出（内置规范模型名，保 `${whisperModel}` 替换）。 */
  includeLocalCli?: boolean;
  /** 当前选中的引擎与模型（二者共同决定选中项；任一缺失或不在分组内则视为未选）。 */
  engine?: TranscriptionEngine;
  model?: string;
  /** 选中某分组下某模型：同时回传 (引擎, 模型)。 */
  onChange?: (engine: TranscriptionEngine, model: string) => void;
  className?: string;
  disabled?: boolean;
}

/**
 * 「引擎 ▸ 模型」分组选择器（逐任务引擎）。
 * 选项按引擎分组，每项 value 编码 (引擎, 模型)；选中后同时确定二者，消除同名模型歧义。
 */
const Models = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  IProps
>((props, ref) => {
  const { t } = useTranslation('common');
  const {
    modelsInstalled,
    fasterWhisperModelsInstalled,
    funasrVadInstalled,
    funasrAsrModelsInstalled,
    pythonEngineStatus,
    funasrEngineInstalled,
    qwenVadInstalled,
    qwenModelsInstalled,
    qwenEngineInstalled,
    fireRedVadInstalled,
    fireRedModelsInstalled,
    fireRedEngineInstalled,
    includeLocalCli,
    engine,
    model,
    onChange,
    className,
    disabled,
  } = props;

  const groups = getEngineModelGroups(
    {
      modelsInstalled,
      fasterWhisperModelsInstalled,
      funasrVadInstalled,
      funasrAsrModelsInstalled,
      pythonEngineStatus,
      funasrEngineInstalled,
      qwenVadInstalled,
      qwenModelsInstalled,
      qwenEngineInstalled,
      fireRedVadInstalled,
      fireRedModelsInstalled,
      fireRedEngineInstalled,
    },
    { includeLocalCli },
  );

  const engineLabel = (e: TranscriptionEngine) =>
    t(`engineBadge.${e}`, { defaultValue: e });

  // 仅当 (引擎,模型) 确实存在于分组中才视为有效选中，避免残留旧选择悬空显示
  const selected =
    engine &&
    model &&
    groups.some(
      (g) =>
        g.engine === engine &&
        g.models.some((m) => m.toLowerCase() === model.toLowerCase()),
    )
      ? { engine, model }
      : null;
  const currentValue = selected
    ? encodeEngineModel(selected.engine, selected.model)
    : undefined;

  const handleValueChange = (value: string) => {
    const decoded = decodeEngineModel(value);
    if (decoded) onChange?.(decoded.engine, decoded.model);
  };

  return (
    <Select
      value={currentValue}
      onValueChange={handleValueChange}
      disabled={disabled}
    >
      <SelectTrigger className={className} id="model" ref={ref}>
        {selected ? (
          <span className="flex min-w-0 items-center gap-1 truncate">
            <span className="text-muted-foreground">
              {engineLabel(selected.engine)}
            </span>
            <span className="opacity-50">·</span>
            <span className="truncate">{selected.model}</span>
          </span>
        ) : (
          <SelectValue placeholder={t('pleaseSelect')} />
        )}
      </SelectTrigger>
      <SelectContent>
        {groups.length > 0 ? (
          groups.map((group) => (
            <SelectGroup key={group.engine}>
              <SelectLabel>{engineLabel(group.engine)}</SelectLabel>
              {group.models.map((m) => (
                <SelectItem
                  value={encodeEngineModel(group.engine, m)}
                  key={`${group.engine}:${m}`}
                >
                  {m}
                </SelectItem>
              ))}
            </SelectGroup>
          ))
        ) : (
          <SelectItem value="no-models" disabled>
            {t('noModelsInstalled')}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
});

Models.displayName = 'Models';

export default Models;
