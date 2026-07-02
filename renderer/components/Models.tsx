import React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslation } from 'next-i18next';
import {
  decodeEngineModel,
  encodeEngineModel,
  getEngineModelGroups,
  isEngineModelSelected,
} from 'lib/engineModels';
import EngineIcon from '@/components/resources/engines/EngineIcon';
import type { EngineStatus, TranscriptionEngine } from '../../types/engine';
import type { AsrProvider } from '../../types/asrProvider';

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
  /** 云端听写服务商实例（每个已配置实例为一分组，实例名为组名）。 */
  asrProviders?: AsrProvider[];
  /** 当前选中的引擎与模型（二者共同决定选中项；任一缺失或不在分组内则视为未选）。 */
  engine?: TranscriptionEngine;
  model?: string;
  /** 云引擎选中的实例 id（engine==='cloud' 时用于多实例消歧）。 */
  asrProviderId?: string;
  /** 选中某分组下某模型：同时回传 (引擎, 模型[, 云实例 id])。 */
  onChange?: (
    engine: TranscriptionEngine,
    model: string,
    asrProviderId?: string,
  ) => void;
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
    asrProviders,
    engine,
    model,
    asrProviderId,
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
    { includeLocalCli, asrProviders },
  );

  const engineLabel = (e: TranscriptionEngine) =>
    t(`engineBadge.${e}`, { defaultValue: e });
  // 云实例分组用实例名作组名/徽标；其它引擎用引擎名。
  const groupLabel = (g: (typeof groups)[number]) =>
    g.engine === 'cloud' && g.label ? g.label : engineLabel(g.engine);

  // 仅当 (引擎,模型[,云实例]) 确实存在于分组中才视为有效选中，避免残留旧选择悬空显示
  const selectedGroup = groups.find((g) =>
    isEngineModelSelected(g, { engine, model, asrProviderId }),
  );
  const selected =
    selectedGroup && model
      ? { engine: selectedGroup.engine, model, group: selectedGroup }
      : null;
  const currentValue = selected
    ? encodeEngineModel(
        selected.engine,
        selected.model,
        selected.group.asrProviderId,
      )
    : undefined;

  const handleValueChange = (value: string) => {
    const decoded = decodeEngineModel(value);
    if (decoded)
      onChange?.(decoded.engine, decoded.model, decoded.asrProviderId);
  };

  return (
    <Select
      value={currentValue}
      onValueChange={handleValueChange}
      disabled={disabled}
    >
      <SelectTrigger className={className} id="model" ref={ref}>
        {selected ? (
          // 用 div 承载（而非 span）：SelectTrigger 的 `[&>span]:line-clamp-1`
          // 会把直接子 span 设为竖排 -webkit-box，导致图标/徽标/模型名换行竖排。
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap">
            <EngineIcon engine={selected.engine} className="h-4 w-4 shrink-0" />
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
              {groupLabel(selected.group)}
            </span>
            <span className="truncate font-medium text-foreground">
              {selected.model}
            </span>
          </div>
        ) : (
          <SelectValue placeholder={t('pleaseSelect')} />
        )}
      </SelectTrigger>
      <SelectContent>
        {groups.length > 0 ? (
          groups.map((group, index) => {
            const groupKey =
              group.engine === 'cloud'
                ? `cloud:${group.asrProviderId}`
                : group.engine;
            return (
              <SelectGroup key={groupKey}>
                {index > 0 && <SelectSeparator />}
                <SelectLabel className="flex items-center gap-1.5 pl-2 text-foreground">
                  <EngineIcon engine={group.engine} className="h-4 w-4" />
                  <span>{groupLabel(group)}</span>
                </SelectLabel>
                {group.models.map((m) => (
                  <SelectItem
                    value={encodeEngineModel(
                      group.engine,
                      m,
                      group.asrProviderId,
                    )}
                    key={`${groupKey}:${m}`}
                    className="text-muted-foreground data-[state=checked]:text-foreground"
                  >
                    {m}
                  </SelectItem>
                ))}
              </SelectGroup>
            );
          })
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
