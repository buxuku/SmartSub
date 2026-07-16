/**
 * 新建任务向导（目标驱动，一屏）：
 * 拖入文件自动识别 → 勾选目标产物（字幕/翻译/配音/成品视频）→ 阶段链芯片可视化
 * → 分区就地配置（字幕段复用 InlineConfigBar；配音/合成为轻量行）→ 就绪校验 → 开始。
 * 配置为本地表单（useLocalFormConfig），随任务写入配置快照，不污染全局 userConfig。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/router';
import { v4 as uuidv4 } from 'uuid';
import Link from 'next/link';
import {
  ArrowRight,
  AudioLines,
  BookmarkPlus,
  Check,
  ChevronRight,
  Clapperboard,
  FileText,
  Film,
  Import,
  Info,
  Languages,
  Mic2,
  Play,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/panel';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn, isSubtitleFile } from 'lib/utils';
import { getTaskTypeByValue } from 'lib/taskTypes';
import { isProviderConfigured } from 'lib/providerUtils';
import { resolveDefaultTranslateProviderId } from 'lib/providerPanelUtils';
import {
  getEngineModelGroups,
  isEngineModelSelected,
  pickDefaultEngineModel,
} from 'lib/engineModels';
import InlineConfigBar from '@/components/tasks/InlineConfigBar';
import useSystemInfo from 'hooks/useStystemInfo';
import useLocalFormConfig from 'hooks/useLocalFormConfig';
import useLocalStorageState from 'hooks/useLocalStorageState';
import { useTtsEngineOptions, parseEngineKey } from 'hooks/useTtsEngineOptions';
import {
  BUILTIN_RECIPES,
  recipeToWizardPrefill,
  WIZARD_DROP_KEY,
} from 'lib/recipes';
import { pairMediaWithSubtitlesManual } from 'lib/filePairing';
import {
  STYLE_PRESETS,
  getDefaultStyle,
  getPlatformDefaultFont,
} from '@/components/subtitleMerge/constants';
import { useTranslation } from 'next-i18next';
import type { TranscriptionEngine } from '../../../../types/engine';
import type { AsrProvider } from '../../../../types/asrProvider';
import type {
  IFiles,
  IFormData,
  PipelineComposeConfig,
} from '../../../../types';
import type { TaskRecipe } from '../../../../types/recipe';
import type {
  EncoderMode,
  HwAccelInfo,
  UserStylePreset,
  VideoQuality,
} from '../../../../types/subtitleMerge';

type GoalKey = 'translate' | 'dub' | 'video';

/** 工作台同款配音记忆配置（同 key 共享，向导改动同步为工作台默认） */
interface PersistedDubbing {
  engineKey: string;
  voice: string;
  globalSpeed: number;
  cloneQuality?: 'standard' | 'high';
  localConcurrency?: number;
}

const SPEED_OPTIONS = [0.75, 0.9, 1, 1.1, 1.25, 1.5];

export default function TaskWizard() {
  const router = useRouter();
  const locale =
    typeof router.query.locale === 'string' ? router.query.locale : 'zh';
  const { t } = useTranslation('tasks');
  const { t: tMerge } = useTranslation('subtitleMerge');

  // ── 文件区 ────────────────────────────────────────────────────────────────
  // 支持三种输入形态：纯媒体（转写起步）、纯字幕（翻译/配音起步）、
  // 媒体+字幕混合（配对模式：同名字幕即源字幕，跳过听写）
  const [files, setFiles] = useState<IFiles[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const mediaFiles = useMemo(
    () => files.filter((f) => !isSubtitleFile(f.filePath)),
    [files],
  );
  const subtitleFiles = useMemo(
    () => files.filter((f) => isSubtitleFile(f.filePath)),
    [files],
  );
  const inputKind: 'media' | 'subtitle' | 'paired' | null =
    mediaFiles.length && subtitleFiles.length
      ? 'paired'
      : mediaFiles.length
        ? 'media'
        : subtitleFiles.length
          ? 'subtitle'
          : null;
  // 手动指派的配对（媒体路径 → 字幕路径）：兼容字幕名与视频名不一致的场景，
  // 未指派的媒体照常走同名自动配对；指派同一字幕会从其它视频行「抢走」它
  const [manualPairs, setManualPairs] = useState<Map<string, string>>(
    () => new Map(),
  );
  const pairing = useMemo(
    () =>
      inputKind === 'paired'
        ? pairMediaWithSubtitlesManual(mediaFiles, subtitleFiles, manualPairs)
        : null,
    [inputKind, mediaFiles, subtitleFiles, manualPairs],
  );
  const pairedSubtitleByMediaPath = useMemo(() => {
    const map = new Map<string, IFiles>();
    pairing?.pairs.forEach((p) => map.set(p.media.filePath, p.subtitle));
    return map;
  }, [pairing]);
  /** 字幕 → 占用它的视频（下拉里给已被其它行选中的字幕加标记） */
  const subtitleOwnerByPath = useMemo(() => {
    const map = new Map<string, string>();
    pairing?.pairs.forEach((p) =>
      map.set(p.subtitle.filePath, p.media.filePath),
    );
    return map;
  }, [pairing]);
  /** 可参与配对的字幕（txt 无时间轴，烧录/配音均不可用） */
  const pairableSubtitles = useMemo(
    () => subtitleFiles.filter((s) => !/\.txt$/i.test(s.filePath)),
    [subtitleFiles],
  );

  /** 删除视频行：合并行语义，连同其配对字幕一起移除（含手动指派记录） */
  const removeMediaRow = useCallback(
    (mediaPath: string) => {
      const paired = pairedSubtitleByMediaPath.get(mediaPath);
      setFiles((prev) =>
        prev.filter(
          (f) => f.filePath !== mediaPath && f.filePath !== paired?.filePath,
        ),
      );
      setManualPairs((prev) => {
        if (!prev.has(mediaPath)) return prev;
        const next = new Map(prev);
        next.delete(mediaPath);
        return next;
      });
    },
    [pairedSubtitleByMediaPath],
  );

  /** 给视频行手动指派字幕；同一字幕的旧指派让位（最后操作生效） */
  const assignSubtitle = useCallback(
    (mediaPath: string, subtitlePath: string) => {
      setManualPairs((prev) => {
        const next = new Map(prev);
        next.forEach((subtitle, media) => {
          if (subtitle === subtitlePath && media !== mediaPath) {
            next.delete(media);
          }
        });
        next.set(mediaPath, subtitlePath);
        return next;
      });
    },
    [],
  );

  /** 从磁盘挑字幕文件配给指定视频（文件同时进入列表，供其它行选用） */
  const handleBrowseSubtitle = useCallback(
    async (mediaPath: string) => {
      const result = await window?.ipc?.invoke('selectFiles', {
        type: 'subtitle',
        multiple: false,
      });
      if (!result || result.canceled || !result.filePaths?.length) return;
      const picked = result.filePaths[0] as string;
      if (/\.txt$/i.test(picked)) {
        toast.error(t('wizard.pairTxtUnsupported'));
        return;
      }
      const wrapped = ((await window?.ipc?.invoke('getDroppedFiles', {
        files: [picked],
        taskType: 'translate',
      })) ?? [])[0] as IFiles | undefined;
      if (!wrapped) return;
      // 已导入过同一文件属预期（重新指派），静默去重不提示
      setFiles((prev) =>
        prev.some((f) => f.filePath === wrapped.filePath)
          ? prev
          : [...prev, wrapped],
      );
      assignSubtitle(mediaPath, wrapped.filePath);
    },
    [assignSubtitle, t],
  );

  const appendFiles = useCallback(
    (incoming: IFiles[]) => {
      if (!incoming?.length) return;
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.filePath));
        const fresh: IFiles[] = [];
        let dup = 0;
        for (const file of incoming) {
          if (seen.has(file.filePath)) {
            dup += 1;
            continue;
          }
          seen.add(file.filePath);
          fresh.push(file);
        }
        if (dup > 0) toast.info(t('skippedDuplicates', { count: dup }));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
    },
    [t],
  );

  // 导入对话框（openDialog → file-selected 事件回流）
  useEffect(() => {
    const cleanup = window?.ipc?.on('file-selected', (res: IFiles[]) => {
      appendFiles(res);
    });
    return () => cleanup?.();
  }, [appendFiles]);

  // 单按钮混合导入：一次选择即可同时带入视频/音频与字幕（含目录展开），
  // 同名字幕自动进入配对模式
  const handleImport = () => {
    window?.ipc?.send('openDialog', {
      dialogType: 'openDialog',
      fileType: 'any',
    });
  };

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const paths: string[] = [];
      for (const f of Array.from(e.dataTransfer.files)) {
        const p = window?.ipc?.getPathForFile?.(f) ?? (f as any).path;
        if (p) paths.push(p);
      }
      if (!paths.length) return;
      // 双类型解析：媒体与字幕各过一遍过滤（含目录展开），混合拖入进配对模式
      const [droppedMedia, droppedSubtitles] = await Promise.all([
        window?.ipc?.invoke('getDroppedFiles', {
          files: paths,
          taskType: 'media',
        }),
        window?.ipc?.invoke('getDroppedFiles', {
          files: paths,
          taskType: 'translate',
        }),
      ]);
      const dropped = [...(droppedMedia ?? []), ...(droppedSubtitles ?? [])];
      if (dropped.length) appendFiles(dropped);
    },
    [appendFiles],
  );

  // 启动台拖放交接：sessionStorage 一次性消费
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(WIZARD_DROP_KEY);
      if (raw) {
        sessionStorage.removeItem(WIZARD_DROP_KEY);
        const dropped = JSON.parse(raw) as IFiles[];
        if (Array.isArray(dropped) && dropped.length) appendFiles(dropped);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 目标产物 ──────────────────────────────────────────────────────────────
  const presetFull = router.query.preset === 'full';
  const [goals, setGoals] = useState<Record<GoalKey, boolean>>({
    translate: presetFull,
    dub: presetFull,
    video: presetFull,
  });
  const toggleGoal = (key: GoalKey) =>
    setGoals((prev) => ({ ...prev, [key]: !prev[key] }));
  const videoAllowed = inputKind !== 'subtitle';
  const videoOn = goals.video && videoAllowed;
  const dubOn = goals.dub;
  const translateOn = goals.translate;

  // ── 字幕段配置（本地表单 + InlineConfigBar 复用）─────────────────────────
  const { form, formData, loaded: formLoaded } = useLocalFormConfig();
  const { systemInfo, loaded: systemInfoLoaded } = useSystemInfo();
  const [providers, setProviders] = useState<any[]>([]);
  const [asrProviders, setAsrProviders] = useState<AsrProvider[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [useLocalWhisper, setUseLocalWhisper] = useState(false);
  const [lastUsedTranscription, setLastUsedTranscription] = useState<{
    engine?: TranscriptionEngine;
    model?: string;
    asrProviderId?: string;
  } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setProviders(
          (await window?.ipc?.invoke('getTranslationProviders')) || [],
        );
        setAsrProviders((await window?.ipc?.invoke('getAsrProviders')) || []);
        const settings = await window?.ipc?.invoke('getSettings');
        setUseLocalWhisper(settings?.useLocalWhisper || false);
        setLastUsedTranscription(settings?.lastUsedTranscription || null);
      } finally {
        setProvidersLoaded(true);
      }
    })();
  }, []);

  const taskType =
    inputKind === 'subtitle'
      ? 'translateOnly'
      : translateOn
        ? 'generateAndTranslate'
        : 'generateOnly';
  const typeDef = getTaskTypeByValue(taskType)!;
  // 字幕段配置条：媒体输入（有转写配置）或勾了翻译时才有可配项；
  // 配对模式跳过听写（无模型项），源语言标签按字幕语义展示
  const showSubtitleConfig =
    inputKind === 'media' || inputKind === null || translateOn;
  const configTypeDef =
    inputKind === 'paired'
      ? { ...typeDef, needsModel: false, accepts: 'subtitle' as const }
      : typeDef;

  // 默认 (引擎,模型) 校正（同任务页语义；配对模式不转写无需模型）
  useEffect(() => {
    if (inputKind === 'subtitle' || inputKind === 'paired') return;
    if (!systemInfoLoaded || !providersLoaded || !formLoaded) return;
    if (!formData || Object.keys(formData).length === 0) return;
    const groups = getEngineModelGroups(systemInfo, {
      includeLocalCli: useLocalWhisper,
      asrProviders,
    });
    if (!groups.length) return;
    const currentValid = groups.some((g) =>
      isEngineModelSelected(g, {
        engine: formData.transcriptionEngine as TranscriptionEngine | undefined,
        model: formData.model,
        asrProviderId: formData.asrProviderId,
      }),
    );
    if (currentValid) return;
    const next = pickDefaultEngineModel(
      groups,
      lastUsedTranscription ?? undefined,
    );
    if (next) {
      form.setValue('transcriptionEngine', next.engine);
      form.setValue('model', next.model);
      form.setValue('asrProviderId', next.asrProviderId ?? '');
    }
  }, [
    inputKind,
    systemInfo,
    systemInfoLoaded,
    providersLoaded,
    formLoaded,
    useLocalWhisper,
    asrProviders,
    lastUsedTranscription,
    formData?.transcriptionEngine,
    formData?.model,
    formData?.asrProviderId,
    form,
  ]);

  // 翻译服务默认值校正（勾了翻译才需要）
  useEffect(() => {
    if (!translateOn || !providers.length || !formLoaded) return;
    const current = formData?.translateProvider;
    const valid = providers.some((p: any) => p.id === current);
    if (current && current !== '-1' && valid) return;
    form.setValue(
      'translateProvider',
      resolveDefaultTranslateProviderId(providers as any[], current),
    );
  }, [translateOn, providers, formLoaded, formData?.translateProvider, form]);

  // ── 配音配置（工作台同款记忆）─────────────────────────────────────────────
  const { engineOptions } = useTtsEngineOptions();
  const [dubPersisted, setDubPersisted] =
    useLocalStorageState<PersistedDubbing>('dubbingConfig', {
      engineKey: '',
      voice: '',
      globalSpeed: 1,
      cloneQuality: 'standard',
      localConcurrency: 1,
    } as PersistedDubbing);
  const activeEngine = useMemo(() => {
    const ready = engineOptions.filter((o) => o.ready);
    return (
      engineOptions.find((o) => o.key === dubPersisted.engineKey && o.ready) ??
      ready[0] ??
      null
    );
  }, [engineOptions, dubPersisted.engineKey]);
  const activeVoice = useMemo(() => {
    if (!activeEngine) return '';
    return (
      activeEngine.voices.find((v) => v.id === dubPersisted.voice)?.id ??
      activeEngine.defaultVoiceId ??
      activeEngine.voices[0]?.id ??
      ''
    );
  }, [activeEngine, dubPersisted.voice]);

  // ── 合成配置 ──────────────────────────────────────────────────────────────
  const [composeSubtitle, setComposeSubtitle] = useState<
    'hard' | 'soft' | 'none'
  >('hard');
  // 烧录样式/画质/编码（仅 hard 生效）：样式候选 = 系统预设 + 我的样式；
  // 画质/编码默认沿用合成工作台偏好，配方带值时以配方为准
  const [composeStyleId, setComposeStyleId] = useState('classic');
  const [composeQuality, setComposeQuality] =
    useState<VideoQuality>('original');
  const [composeEncoder, setComposeEncoder] = useState<EncoderMode>('cpu');
  const [userStylePresets, setUserStylePresets] = useState<UserStylePreset[]>(
    [],
  );
  const [mergeHwInfo, setMergeHwInfo] = useState<HwAccelInfo | null>(null);
  /** 画质/编码已被配方或用户显式设定：合成偏好加载不再覆盖 */
  const composeMetaTouchedRef = useRef(false);
  const composeMetaLoadedRef = useRef(false);

  // 勾选成品视频后按需加载：我的样式清单、合成偏好默认值、硬件编码探测
  useEffect(() => {
    if (!videoOn || composeMetaLoadedRef.current) return;
    composeMetaLoadedRef.current = true;
    (async () => {
      try {
        const presets = await window?.ipc?.invoke(
          'subtitleMerge:listStylePresets',
        );
        if (presets?.success && Array.isArray(presets.data)) {
          setUserStylePresets(presets.data);
        }
      } catch {
        /* ignore */
      }
      try {
        const prefs = await window?.ipc?.invoke('subtitleMerge:getPreferences');
        if (prefs?.success && prefs.data && !composeMetaTouchedRef.current) {
          if (prefs.data.videoQuality) {
            setComposeQuality(prefs.data.videoQuality);
          }
          if (prefs.data.encoderMode) {
            setComposeEncoder(prefs.data.encoderMode);
          }
        }
      } catch {
        /* ignore */
      }
      try {
        const hw = await window?.ipc?.invoke('subtitleMerge:getHwAccelInfo');
        if (hw?.success && hw.data) setMergeHwInfo(hw.data);
      } catch {
        /* ignore */
      }
    })();
  }, [videoOn]);

  /** 选中样式失效（我的样式被删/配方引用失效）时回落经典预设 */
  const effectiveComposeStyleId = useMemo(() => {
    if (STYLE_PRESETS.some((p) => p.id === composeStyleId)) {
      return composeStyleId;
    }
    if (userStylePresets.some((p) => p.id === composeStyleId)) {
      return composeStyleId;
    }
    return 'classic';
  }, [composeStyleId, userStylePresets]);

  /** 生效编码方式：选了硬件但本机不可用时按 CPU（与合成工作台同语义） */
  const effectiveComposeEncoder: EncoderMode =
    composeEncoder === 'hardware' && mergeHwInfo?.available
      ? 'hardware'
      : 'cpu';

  /** 解析选中样式为可执行的样式对象 + 展示名（写入任务快照） */
  const resolveComposeStyle = () => {
    const userPreset = userStylePresets.find(
      (p) => p.id === effectiveComposeStyleId,
    );
    if (userPreset) {
      return {
        style: { ...getDefaultStyle(), ...userPreset.style },
        name: userPreset.name,
      };
    }
    const system =
      STYLE_PRESETS.find((p) => p.id === effectiveComposeStyleId) ??
      STYLE_PRESETS[0];
    return {
      style:
        system.id === 'classic'
          ? { ...system.style, fontName: getPlatformDefaultFont() }
          : system.style,
      name: tMerge(system.nameKey) || system.name,
    };
  };

  /** 组装合成配置（任务 payload 与配方共用）：soft/none 无烧录参数 */
  const buildComposePayload = (): PipelineComposeConfig => {
    if (composeSubtitle !== 'hard') return { subtitle: composeSubtitle };
    const resolved = resolveComposeStyle();
    return {
      subtitle: 'hard',
      styleId: effectiveComposeStyleId,
      styleName: resolved.name,
      style: resolved.style,
      videoQuality: composeQuality,
      encoderMode: effectiveComposeEncoder,
    };
  };

  // ── 人工把关（下游有成本型阶段时显示；字幕校对默认开，配音确认默认关）────
  const gatesVisible = dubOn || videoOn;
  const [subtitleGateOn, setSubtitleGateOn] = useState(true);
  const [dubbingGateOn, setDubbingGateOn] = useState(false);

  // 配对模式的字幕是用户自备的，通常无需再校对：进入配对默认关、离开恢复默认开
  const prevKindRef = useRef<typeof inputKind>(inputKind);
  useEffect(() => {
    if (prevKindRef.current === inputKind) return;
    if (inputKind === 'paired') setSubtitleGateOn(false);
    else if (prevKindRef.current === 'paired') setSubtitleGateOn(true);
    prevKindRef.current = inputKind;
  }, [inputKind]);

  // ── 配方预填（?recipe=<id>）：内置走常量、用户走 IPC ─────────────────────
  const recipeId =
    typeof router.query.recipe === 'string' ? router.query.recipe : '';
  const appliedRecipeRef = useRef(false);
  const [pendingRecipeConfig, setPendingRecipeConfig] =
    useState<Partial<IFormData> | null>(null);
  /** 已应用的用户配方名：随任务快照记录，任务页标题展示（内置配方无名） */
  const [appliedRecipeName, setAppliedRecipeName] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!recipeId || appliedRecipeRef.current) return;
    appliedRecipeRef.current = true;
    (async () => {
      let recipe = BUILTIN_RECIPES.find((r) => r.id === recipeId) ?? null;
      if (!recipe) {
        const list = ((await window?.ipc?.invoke('recipes:list')) ??
          []) as TaskRecipe[];
        recipe = list.find((r) => r.id === recipeId) ?? null;
      }
      // 失效引用（配方已删）：静默回落为空白向导
      if (!recipe) return;
      const prefill = recipeToWizardPrefill(recipe);
      setGoals(prefill.goals);
      setSubtitleGateOn(prefill.subtitleGateOn);
      setDubbingGateOn(prefill.dubbingGateOn);
      if (prefill.config) setPendingRecipeConfig(prefill.config);
      setAppliedRecipeName(recipe.name?.trim() || null);
      if (!recipe.builtin) {
        toast.success(t('wizard.recipe.applied', { name: recipe.name }));
      }
    })();
  }, [recipeId, t]);

  // 配方 config 浅合并：等本地表单默认值加载后应用（缺字段回落默认；
  // 引擎/服务商失效由既有就绪校验与默认值校正兜底）
  useEffect(() => {
    if (!pendingRecipeConfig || !formLoaded) return;
    const {
      dub,
      compose,
      gates: _gates,
      taskType: _taskType,
      ...subtitleFields
    } = pendingRecipeConfig;
    form.reset({ ...form.getValues(), ...subtitleFields });
    if (dub) {
      setDubPersisted((prev: PersistedDubbing) => ({
        ...prev,
        engineKey:
          dub.engine.kind === 'local'
            ? `local:${dub.engine.modelId}`
            : `cloud:${dub.engine.providerId}`,
        voice: dub.voice,
        globalSpeed: dub.globalSpeed || 1,
        cloneQuality: dub.cloneQuality ?? prev.cloneQuality,
        localConcurrency: dub.localConcurrency ?? prev.localConcurrency,
      }));
    }
    if (compose?.subtitle) setComposeSubtitle(compose.subtitle);
    // 配方带的烧录参数优先于合成偏好默认值（touched 标记阻止偏好覆盖）；
    // styleId 若已失效（我的样式被删）由 effectiveComposeStyleId 回落经典
    if (compose?.styleId) {
      setComposeStyleId(compose.styleId);
      composeMetaTouchedRef.current = true;
    }
    if (compose?.videoQuality) {
      setComposeQuality(compose.videoQuality);
      composeMetaTouchedRef.current = true;
    }
    if (compose?.encoderMode) {
      setComposeEncoder(compose.encoderMode);
      composeMetaTouchedRef.current = true;
    }
    setPendingRecipeConfig(null);
  }, [pendingRecipeConfig, formLoaded, form, setDubPersisted]);

  // ── 阶段链与就绪校验 ──────────────────────────────────────────────────────
  const chips = useMemo(() => {
    const list: Array<{ key: string; label: string; icon: React.ElementType }> =
      [];
    if (inputKind !== 'subtitle' && inputKind !== 'paired') {
      list.push({
        key: 'transcribe',
        label: t('stage.transcribe'),
        icon: Mic2,
      });
    }
    if (translateOn) {
      list.push({
        key: 'translate',
        label: t('stage.translate'),
        icon: Languages,
      });
    }
    if (dubOn) {
      list.push({ key: 'dub', label: t('stage.dubbing'), icon: AudioLines });
    }
    if (videoOn) {
      list.push({ key: 'compose', label: t('stage.compose'), icon: Film });
    }
    return list;
  }, [inputKind, translateOn, dubOn, videoOn, t]);

  const blockers = useMemo(() => {
    const list: Array<{ key: string; text: string; href?: string }> = [];
    if (!files.length) {
      list.push({ key: 'files', text: t('wizard.blockNoFiles') });
      return list;
    }
    if (inputKind === 'media') {
      const groups = getEngineModelGroups(systemInfo, {
        includeLocalCli: useLocalWhisper,
        asrProviders,
      });
      if (!groups.length) {
        list.push({
          key: 'model',
          text: t('wizard.blockNoModel'),
          href: `/${locale}/engines`,
        });
      }
    }
    // 配对模式：每个视频必须有同名字幕（缺配对的先移除或补字幕）
    if (pairing && pairing.unpairedMedia.length > 0) {
      list.push({
        key: 'pair',
        text: t('wizard.blockUnpairedMedia', {
          count: pairing.unpairedMedia.length,
        }),
      });
    }
    if (translateOn) {
      const provider = providers.find(
        (p: any) => p.id === formData?.translateProvider,
      );
      if (!provider || !isProviderConfigured(provider)) {
        list.push({
          key: 'provider',
          text: t('wizard.blockNoProvider'),
          href: `/${locale}/translation`,
        });
      }
    }
    if (dubOn && (!activeEngine || !activeVoice)) {
      list.push({
        key: 'tts',
        text: t('wizard.blockNoTts'),
        href: `/${locale}/ttsServices`,
      });
    }
    if (goals.video && !videoAllowed) {
      list.push({ key: 'video', text: t('wizard.blockVideoNeedsMedia') });
    }
    if (
      !translateOn &&
      !dubOn &&
      !videoOn &&
      (inputKind === 'subtitle' || inputKind === 'paired')
    ) {
      list.push({ key: 'goal', text: t('wizard.blockNoGoal') });
    }
    return list;
  }, [
    files.length,
    inputKind,
    pairing,
    systemInfo,
    useLocalWhisper,
    asrProviders,
    translateOn,
    providers,
    formData?.translateProvider,
    dubOn,
    activeEngine,
    activeVoice,
    goals.video,
    videoAllowed,
    videoOn,
    locale,
    t,
  ]);

  const canStart = files.length > 0 && blockers.length === 0;

  // ── 存为配方：打包 {goals, accepts, config(字幕段+dub+compose+gates)} ─────
  const [recipeDialogOpen, setRecipeDialogOpen] = useState(false);
  const [recipeName, setRecipeName] = useState('');
  const [savingRecipe, setSavingRecipe] = useState(false);
  const handleSaveRecipe = async () => {
    const name = recipeName.trim();
    if (!name || savingRecipe) return;
    setSavingRecipe(true);
    try {
      const dubEngine =
        dubOn && activeEngine ? parseEngineKey(activeEngine.key) : null;
      const config: Partial<IFormData> = { ...formData };
      delete config.taskType;
      delete config.dub;
      delete config.compose;
      delete config.gates;
      if (dubOn && dubEngine) {
        config.dub = {
          engine: dubEngine,
          voice: activeVoice,
          globalSpeed: dubPersisted.globalSpeed || 1,
          cloneQuality: dubPersisted.cloneQuality ?? 'standard',
          localConcurrency: dubPersisted.localConcurrency ?? 1,
          overflow: 'truncate',
          overlapMode: 'shift',
        };
      }
      if (videoOn) config.compose = buildComposePayload();
      if (gatesVisible) {
        config.gates = {
          subtitle: subtitleGateOn ? 'manual' : 'auto',
          ...(dubOn ? { dubbing: dubbingGateOn ? 'manual' : 'auto' } : {}),
        };
      }
      const saved = await window?.ipc?.invoke('recipes:save', {
        name,
        goals: { translate: translateOn, dub: dubOn, video: videoOn },
        // 配对是文件形态而非配方属性：配方按媒体入口收（拖放时向导自动配对）
        accepts: inputKind === 'subtitle' ? 'subtitle' : 'media',
        config,
      });
      if (saved) {
        toast.success(t('wizard.recipe.saved', { name }));
        setRecipeDialogOpen(false);
        setRecipeName('');
        // 存完即跑的任务同样视为「来自该配方」，标题沿用配方名
        setAppliedRecipeName(name);
      }
    } finally {
      setSavingRecipe(false);
    }
  };

  // ── 开始 ──────────────────────────────────────────────────────────────────
  const [starting, setStarting] = useState(false);
  const handleStart = async () => {
    if (!canStart || starting) return;
    setStarting(true);
    try {
      const projectId = uuidv4();
      const dubEngine = dubOn ? parseEngineKey(activeEngine!.key) : null;
      // 配对模式：任务文件 = 媒体文件（携带配对字幕路径）；未配对字幕不进任务
      const taskFiles =
        inputKind === 'paired'
          ? pairing!.pairs.map((p) => ({
              ...p.media,
              providedSubtitlePath: p.subtitle.filePath,
            }))
          : files;
      const payload = {
        ...formData,
        taskType,
        ...(appliedRecipeName ? { recipeName: appliedRecipeName } : {}),
        translateProvider: translateOn ? formData?.translateProvider : '-1',
        ...(dubOn && dubEngine
          ? {
              dub: {
                engine: dubEngine,
                voice: activeVoice,
                globalSpeed: dubPersisted.globalSpeed || 1,
                cloneQuality: dubPersisted.cloneQuality ?? 'standard',
                localConcurrency: dubPersisted.localConcurrency ?? 1,
                overflow: 'truncate',
                overlapMode: 'shift',
              },
            }
          : {}),
        ...(videoOn ? { compose: buildComposePayload() } : {}),
        ...(gatesVisible
          ? {
              gates: {
                subtitle: subtitleGateOn ? 'manual' : 'auto',
                ...(dubOn
                  ? { dubbing: dubbingGateOn ? 'manual' : 'auto' }
                  : {}),
              },
            }
          : {}),
      };
      await window?.ipc?.invoke('saveTaskProject', {
        id: projectId,
        taskType,
        files: taskFiles,
      });
      window?.ipc?.send('handleTask', {
        files: taskFiles,
        formData: payload,
        projectId,
      });
      router.push(`/${locale}/tasks/${typeDef.slug}?project=${projectId}`);
    } finally {
      setStarting(false);
    }
  };

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  const goalDefs: Array<{
    key: GoalKey | 'subtitle';
    icon: React.ElementType;
    checked: boolean;
    disabled: boolean;
    hint?: string;
  }> = [
    {
      key: 'subtitle',
      icon: FileText,
      checked: true,
      disabled: true,
      hint:
        inputKind === 'subtitle'
          ? t('wizard.goalSubtitleHave')
          : inputKind === 'paired'
            ? t('wizard.goalSubtitlePaired')
            : t('wizard.goalSubtitleAlways'),
    },
    {
      key: 'translate',
      icon: Languages,
      checked: translateOn,
      disabled: false,
    },
    { key: 'dub', icon: AudioLines, checked: dubOn, disabled: false },
    {
      key: 'video',
      icon: Clapperboard,
      checked: videoOn,
      disabled: !videoAllowed,
      hint: !videoAllowed ? t('wizard.goalVideoNeedsMedia') : undefined,
    },
  ];

  return (
    <div className="flex h-full flex-col gap-2.5 overflow-y-auto p-3">
      {/* 文件区 */}
      <Panel
        className={cn(
          'flex-none',
          isDragging && 'border-2 border-dashed border-primary bg-primary/5',
        )}
      >
        <PanelHeader
          title={t('wizard.filesTitle')}
          meta={
            inputKind
              ? inputKind === 'media'
                ? t('wizard.detectedMedia', { count: files.length })
                : inputKind === 'subtitle'
                  ? t('wizard.detectedSubtitle', { count: files.length })
                  : t('wizard.detectedPaired', {
                      media: mediaFiles.length,
                      paired: pairing?.pairs.length ?? 0,
                    })
              : undefined
          }
          actions={
            <Button variant="outline" size="sm" onClick={handleImport}>
              <Import className="h-3.5 w-3.5" />
              {t('wizard.importFiles')}
            </Button>
          }
        />
        <div
          className="min-h-[96px] p-2.5"
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setIsDragging(false);
          }}
          onDrop={handleDrop}
        >
          {files.length === 0 ? (
            <div className="flex h-20 flex-col items-center justify-center gap-1">
              <p className="text-sm text-muted-foreground">
                {t('wizard.dropHint')}
              </p>
              <p className="text-[11px] text-faint">{t('wizard.pairHint')}</p>
            </div>
          ) : (
            <div className="max-h-80 space-y-1.5 overflow-y-auto">
              {/* 媒体行：两列铺开（批量时一屏可见更多）；配对模式把配上的
                  字幕合并进本行（可下拉换、可从磁盘挑） */}
              {mediaFiles.length > 0 && (
                <ul className="grid gap-1 sm:grid-cols-2">
                  {mediaFiles.map((file) => {
                    const paired = pairing
                      ? pairedSubtitleByMediaPath.get(file.filePath)
                      : undefined;
                    return (
                      <li
                        key={file.filePath}
                        className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-panel-2 px-2.5 py-1 text-xs"
                      >
                        <Film className="h-3.5 w-3.5 flex-none text-faint" />
                        <span
                          className="min-w-0 flex-1 truncate"
                          title={file.filePath}
                        >
                          {file.fileName}
                          {file.fileExtension}
                        </span>
                        {pairing && (
                          <Select
                            value={paired?.filePath ?? ''}
                            onValueChange={(v) =>
                              assignSubtitle(file.filePath, v)
                            }
                          >
                            <SelectTrigger
                              className={cn(
                                'h-7 w-[200px] flex-none gap-1 px-2 text-xs',
                                paired
                                  ? 'border-success/40 text-success'
                                  : 'border-warning/60 text-warning',
                              )}
                              title={paired?.filePath}
                            >
                              <FileText className="h-3 w-3 flex-none" />
                              <SelectValue
                                placeholder={t('wizard.pairSelectPlaceholder')}
                              />
                            </SelectTrigger>
                            <SelectContent className="max-w-[420px]">
                              {pairableSubtitles.map((sub) => {
                                const owner = subtitleOwnerByPath.get(
                                  sub.filePath,
                                );
                                const takenElsewhere =
                                  owner != null && owner !== file.filePath;
                                return (
                                  <SelectItem
                                    key={sub.filePath}
                                    value={sub.filePath}
                                    textValue={`${sub.fileName}${sub.fileExtension}`}
                                  >
                                    <span className="flex min-w-0 items-center gap-2">
                                      <span className="truncate">
                                        {sub.fileName}
                                        {sub.fileExtension}
                                      </span>
                                      {takenElsewhere && (
                                        <span className="flex-none text-[11px] text-muted-foreground">
                                          {t('wizard.pairAttached')}
                                        </span>
                                      )}
                                    </span>
                                  </SelectItem>
                                );
                              })}
                            </SelectContent>
                          </Select>
                        )}
                        <button
                          type="button"
                          aria-label={t('wizard.pairBrowse')}
                          title={t('wizard.pairBrowse')}
                          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={() => handleBrowseSubtitle(file.filePath)}
                        >
                          <Upload className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          aria-label={t('wizard.removeFile')}
                          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={() => removeMediaRow(file.filePath)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {/* 字幕行：纯字幕任务全部铺开；配对模式只列未被选用的（可在上方视频行选中） */}
              {(pairing
                ? pairing.unpairedSubtitles.length > 0
                : inputKind === 'subtitle') && (
                <ul className="grid gap-1 sm:grid-cols-2">
                  {(pairing ? pairing.unpairedSubtitles : subtitleFiles).map(
                    (file) => (
                      <li
                        key={file.filePath}
                        className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-panel-2 px-2.5 py-1 text-xs"
                      >
                        <FileText className="h-3.5 w-3.5 flex-none text-faint" />
                        <span
                          className="min-w-0 flex-1 truncate"
                          title={file.filePath}
                        >
                          {file.fileName}
                          {file.fileExtension}
                        </span>
                        {pairing && (
                          <span className="flex-none rounded-full border border-warning/40 bg-warning/[0.08] px-2 py-0.5 text-[11px] text-warning">
                            {t('wizard.pairUnmatched')}
                          </span>
                        )}
                        <button
                          type="button"
                          aria-label={t('wizard.removeFile')}
                          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={() =>
                            setFiles((prev) =>
                              prev.filter((f) => f.filePath !== file.filePath),
                            )
                          }
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </li>
                    ),
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      </Panel>

      {/* 目标产物 */}
      <Panel className="flex-none">
        <PanelHeader title={t('wizard.goalsTitle')} />
        <div className="grid gap-2 p-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {goalDefs.map((goal) => {
            const Icon = goal.icon;
            return (
              <button
                key={goal.key}
                type="button"
                disabled={goal.disabled}
                onClick={() =>
                  goal.key !== 'subtitle' && toggleGoal(goal.key as GoalKey)
                }
                className={cn(
                  'relative rounded-md border p-3 text-left transition-colors',
                  goal.checked
                    ? 'border-primary/50 bg-primary/[0.06]'
                    : 'border-border bg-panel-2 hover:border-primary/30',
                  goal.disabled && 'cursor-default opacity-70',
                )}
              >
                <span
                  className={cn(
                    'absolute right-2.5 top-2.5 flex h-4 w-4 items-center justify-center rounded-full border',
                    goal.checked
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-card',
                  )}
                >
                  {goal.checked && <Check className="h-3 w-3" />}
                </span>
                <Icon className="mb-1.5 h-4 w-4 text-muted-foreground" />
                <div className="text-[13px] font-medium">
                  {t(`wizard.goal.${goal.key}`)}
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {goal.hint ?? t(`wizard.goal.${goal.key}Desc`)}
                </p>
              </button>
            );
          })}
        </div>
        {/* 阶段链芯片：按勾选亮起（白话可视化，非交互） */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
          <span className="text-[11px] text-faint">
            {t('wizard.chainLabel')}
          </span>
          {chips.map((chip, index) => {
            const Icon = chip.icon;
            return (
              <React.Fragment key={chip.key}>
                {index > 0 && (
                  <ChevronRight className="h-3 w-3 flex-none text-faint" />
                )}
                <span className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/[0.07] px-2 py-0.5 text-[11px] font-medium text-primary">
                  <Icon className="h-3 w-3" />
                  {chip.label}
                </span>
              </React.Fragment>
            );
          })}
          {chips.length === 0 && (
            <span className="text-[11px] text-muted-foreground">
              {t('wizard.chainEmpty')}
            </span>
          )}
        </div>
      </Panel>

      {/* 字幕段配置（转写/翻译）：复用任务页配置条 */}
      {showSubtitleConfig && (
        <Panel className="flex-none">
          <PanelHeader title={t('wizard.subtitleConfigTitle')} />
          <div className="p-2.5">
            <InlineConfigBar
              form={form}
              formData={formData}
              systemInfo={systemInfo}
              providers={providers}
              asrProviders={asrProviders as any}
              typeDef={configTypeDef}
              useLocalWhisper={useLocalWhisper}
            />
          </div>
        </Panel>
      )}

      {/* 配音配置 */}
      {dubOn && (
        <Panel className="flex-none">
          <PanelHeader title={t('wizard.dubConfigTitle')} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-2.5">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">
                {t('wizard.dubEngine')}
              </Label>
              <Select
                value={activeEngine?.key ?? ''}
                onValueChange={(v) =>
                  setDubPersisted((prev: PersistedDubbing) => ({
                    ...prev,
                    engineKey: v,
                    voice: '',
                  }))
                }
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder={t('wizard.dubEnginePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {engineOptions.map((option) => (
                    <SelectItem
                      key={option.key}
                      value={option.key}
                      disabled={!option.ready}
                    >
                      {option.label}
                      {!option.ready ? ` (${t('wizard.notReady')})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">
                {t('wizard.dubVoice')}
              </Label>
              <Select
                value={activeVoice}
                onValueChange={(v) =>
                  setDubPersisted((prev: PersistedDubbing) => ({
                    ...prev,
                    voice: v,
                  }))
                }
                disabled={!activeEngine}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder={t('wizard.dubVoicePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {(activeEngine?.voices ?? []).map((voice) => (
                    <SelectItem key={voice.id} value={voice.id}>
                      {voice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">
                {t('wizard.dubSpeed')}
              </Label>
              <Select
                value={String(dubPersisted.globalSpeed || 1)}
                onValueChange={(v) =>
                  setDubPersisted((prev: PersistedDubbing) => ({
                    ...prev,
                    globalSpeed: Number(v),
                  }))
                }
              >
                <SelectTrigger className="w-[88px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SPEED_OPTIONS.map((speed) => (
                    <SelectItem key={speed} value={String(speed)}>
                      {speed}x
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {activeEngine?.kind === 'cloud' && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Info className="h-3 w-3" />
                {t('wizard.dubBillingHint')}
              </span>
            )}
          </div>
        </Panel>
      )}

      {/* 合成配置 */}
      {videoOn && (
        <Panel className="flex-none">
          <PanelHeader title={t('wizard.composeConfigTitle')} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-2.5">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">
                {t('wizard.composeSubtitle')}
              </Label>
              <Select
                value={composeSubtitle}
                onValueChange={(v) =>
                  setComposeSubtitle(v as 'hard' | 'soft' | 'none')
                }
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hard">
                    {t('wizard.composeHard')}
                  </SelectItem>
                  <SelectItem value="soft">
                    {t('wizard.composeSoft')}
                  </SelectItem>
                  <SelectItem value="none" disabled={!dubOn}>
                    {t('wizard.composeNone')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {/* 烧录参数：样式（系统预设 + 我的样式）/ 画质 / 编码，仅硬字幕生效 */}
            {composeSubtitle === 'hard' && (
              <>
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground">
                    {t('wizard.composeStyle')}
                  </Label>
                  <Select
                    value={effectiveComposeStyleId}
                    onValueChange={(v) => setComposeStyleId(v)}
                  >
                    <SelectTrigger className="w-[170px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>
                          {t('wizard.composeStyleGroupSystem')}
                        </SelectLabel>
                        {STYLE_PRESETS.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id}>
                            {tMerge(preset.nameKey) || preset.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                      {userStylePresets.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>
                            {t('wizard.composeStyleGroupMine')}
                          </SelectLabel>
                          {userStylePresets.map((preset) => (
                            <SelectItem key={preset.id} value={preset.id}>
                              {preset.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground">
                    {t('wizard.composeQuality')}
                  </Label>
                  <Select
                    value={composeQuality}
                    onValueChange={(v) => {
                      composeMetaTouchedRef.current = true;
                      setComposeQuality(v as VideoQuality);
                    }}
                  >
                    <SelectTrigger className="w-[110px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="original">
                        {tMerge('videoQualityOriginal')}
                      </SelectItem>
                      <SelectItem value="high">
                        {tMerge('videoQualityHigh')}
                      </SelectItem>
                      <SelectItem value="standard">
                        {tMerge('videoQualityStandard')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {mergeHwInfo?.platformSupported !== false && (
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs text-muted-foreground">
                      {t('wizard.composeEncoder')}
                    </Label>
                    <Select
                      value={effectiveComposeEncoder}
                      onValueChange={(v) => {
                        composeMetaTouchedRef.current = true;
                        setComposeEncoder(v as EncoderMode);
                      }}
                    >
                      <SelectTrigger className="w-[130px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cpu">
                          {tMerge('encoderModeCpu')}
                        </SelectItem>
                        <SelectItem
                          value="hardware"
                          disabled={!mergeHwInfo?.available}
                        >
                          {tMerge('encoderModeHardware')}
                          {mergeHwInfo?.encoderLabel
                            ? ` (${mergeHwInfo.encoderLabel})`
                            : ''}
                          {mergeHwInfo && !mergeHwInfo.available
                            ? ` ${t('wizard.composeEncoderUnavailable')}`
                            : ''}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            )}
            {dubOn && (
              <span className="text-[11px] text-muted-foreground">
                {t('wizard.composeAudioHint')}
              </span>
            )}
            {composeSubtitle === 'hard' && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Info className="h-3 w-3" />
                {t('wizard.composeStyleHint')}
                <Link
                  href={`/${locale}/subtitleMerge`}
                  className="text-primary hover:underline"
                >
                  {t('wizard.composeStyleLink')}
                </Link>
              </span>
            )}
          </div>
        </Panel>
      )}

      {/* 人工把关：字幕校对 / 配音确认 */}
      {gatesVisible && (
        <Panel className="flex-none">
          <PanelHeader title={t('wizard.gatesTitle')} />
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 p-2.5">
            <label className="flex cursor-pointer items-center gap-2">
              <Switch
                checked={subtitleGateOn}
                onCheckedChange={setSubtitleGateOn}
              />
              <span className="text-xs font-medium">
                {t('wizard.gateSubtitle')}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {t('wizard.gateSubtitleDesc')}
              </span>
            </label>
            {dubOn && (
              <label className="flex cursor-pointer items-center gap-2">
                <Switch
                  checked={dubbingGateOn}
                  onCheckedChange={setDubbingGateOn}
                />
                <span className="text-xs font-medium">
                  {t('wizard.gateDubbing')}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {t('wizard.gateDubbingDesc')}
                </span>
              </label>
            )}
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Info className="h-3 w-3" />
              {t('wizard.gatesHint')}
            </span>
          </div>
        </Panel>
      )}

      {/* 就绪校验 + 开始 */}
      <Panel className="flex-none">
        <div className="flex flex-wrap items-center gap-3 p-2.5">
          <div className="min-w-0 flex-1 space-y-1">
            {blockers.map((blocker) => (
              <p
                key={blocker.key}
                className="flex items-center gap-1.5 text-xs text-warning"
              >
                <TriangleAlert className="h-3.5 w-3.5 flex-none" />
                {blocker.text}
                {blocker.href && (
                  <Link
                    href={blocker.href}
                    className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
                  >
                    {t('wizard.goConfigure')}
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                )}
              </p>
            ))}
            {!blockers.length && files.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('wizard.readyHint', {
                  count:
                    inputKind === 'paired'
                      ? (pairing?.pairs.length ?? 0)
                      : files.length,
                })}
              </p>
            )}
          </div>
          {files.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFiles([]);
                setManualPairs(new Map());
              }}
              className="flex-none"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('wizard.clearFiles')}
            </Button>
          )}
          <Button
            variant="outline"
            size="lg"
            className="flex-none"
            onClick={() => setRecipeDialogOpen(true)}
          >
            <BookmarkPlus className="h-4 w-4" />
            {t('wizard.recipe.save')}
          </Button>
          <Button
            size="lg"
            className="min-w-[140px] flex-none"
            disabled={!canStart || starting}
            onClick={handleStart}
          >
            <Play className="h-4 w-4" />
            {t('wizard.start')}
          </Button>
        </div>
      </Panel>

      {/* 存为配方：命名对话框 */}
      <Dialog open={recipeDialogOpen} onOpenChange={setRecipeDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('wizard.recipe.dialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('wizard.recipe.dialogDesc')}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={recipeName}
            onChange={(e) => setRecipeName(e.target.value)}
            placeholder={t('wizard.recipe.namePlaceholder')}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSaveRecipe();
            }}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRecipeDialogOpen(false)}
            >
              {t('wizard.recipe.cancel')}
            </Button>
            <Button
              disabled={!recipeName.trim() || savingRecipe}
              onClick={handleSaveRecipe}
            >
              {t('wizard.recipe.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
