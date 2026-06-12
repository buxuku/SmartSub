# B14 零碎收尾批次设计与决策记录

> 日期:2026-06-12 · 分支 `feat/resource-hub` · 上游:`docs/superpowers/specs/2026-06-12-remaining-roadmap-design.md` §4
>
> **本批次在无人值守模式下执行**:所有方案决策由代理按项目实际与最佳实践选取,本文档逐项记录「问题 / 采用方案 / 备选方案与不选原因」,供用户事后评审。若评审推翻某决策,对应改动均为局部,可单独返工。

## 探索期复核结论(修正 roadmap 预估)

| roadmap 预估                        | 复核结果                                                                             | 处理                |
| ----------------------------------- | ------------------------------------------------------------------------------------ | ------------------- |
| ModelsTab 复制图标无 tooltip(6.5.3) | **当前分支已有 Tooltip(「复制下载链接」)**                                           | 跳过,不重复做       |
| 95%/90% 在 ModelsTab                | 实际在校对页 `ProofreadFileList.tsx` 字幕下拉(两处),数据来自 subtitleDetector 置信度 | 改动点移到校对页    |
| 格式提示仅文案失真(4.4)             | 还发现点击上传对话框过滤器(9 种视频、不含音频)与拖拽全量清单(29 种)行为不一致        | 一并统一(见决策 #8) |

## 决策记录

### 决策 #1:P1#35 历史工程状态推导

**问题**:启动台 `getProjectStatus(project, userConfig)` 用「当前全局 userConfig」当作工程的 formData 推导阶段,全局 `translateProvider` 改为 `'-1'`(不翻译)时,翻译类历史工程的翻译阶段被剔除,只转写完的文件被误判「已完成」;反之亦然。工程仅持久化 `taskType`,没有当年的 provider 配置,「当年的配置」已不可考。

**采用方案 B:按 taskType 单源推导,移除 userConfig 参与。**`getProjectStatus` 不再接收 userConfig;`getFileStages` 的 formData 参数传 `undefined`(`undefined !== '-1'` 恒真,故 `hasTranslate` 的任务类型恒含翻译阶段)。理由:① 批次「1b28915」已把「不翻译」选项从翻译类任务移除,新工程不会再有 `'-1'` 场景,特判只服务历史残留;② 与任务页行为一致——进入任务页后 `'-1'` 也会被自动改为已配置服务商,翻译阶段总是显示;③ 单源(taskType)推导可预测、不随全局配置漂移,正是 6.1.6 的修复目标。

**备选方案**:A. 从文件自身字段推导(有 `translateSubtitle` 字段即计入翻译阶段)——「等待中」的新文件无任何阶段字段,无法区分「不需要翻译」与「还没开始」,判定不完备,弃。C. 给 TaskProject 增加持久化 formData 快照——能根治但要动存储结构与迁移,收益仅服务历史 `'-1'` 工程这一边缘场景,不成比例,弃(若未来工程需要快照更多配置可再启用)。

**已知边界**:当年用 `'-1'` 跑完的 generateAndTranslate 历史工程会显示「等待中」(翻译阶段未跑)而非「已完成」。该显示与用户重新打开任务页所见一致(任务页也会列出翻译阶段),方向安全。

### 决策 #2:匹配度数字「95%/90%」的解释方式

**问题**:校对页字幕下拉内裸数字「95%」无任何解释(报告 4.4/6.5 截图项),用户只能猜。数字嵌在 Radix `SelectItem` 内部,内嵌 Tooltip 与 Select 的键盘/焦点交互有冲突风险。

**采用方案:数字自解释 + 触发器外图例。**① `SelectItem` 内文案从「95%」改为「95% 匹配」(i18n 插值),数字自带语义;② 下拉触发器 label 行加 `HelpCircle` 小图标 + Tooltip:「百分比为自动匹配置信度:同名文件 95,带语言后缀 90,其余按相似度递减」。

**备选方案**:SelectItem 内嵌 Tooltip——Radix Select 选项聚焦时 Tooltip 触发时序混乱,且键盘导航读屏冗余,弃;只改图例不改文案——下拉收起时仍是裸数字,半解,弃。

### 决策 #3:评分圆点图例与 emoji 档位图标

**问题**:ModelsTab 速度/精度两组圆点(Zap/Target 图标 + 1-5 圆点)无图例;档位标题用 emoji(🚀⚖️🎯)跨平台渲染不一致(5.5)。

**采用方案**:① 圆点组外包 Tooltip:速度「转写速度,5 点最快」、精度「转写精度,5 点最准」(标准 shadcn 四层结构,先例就在同文件复制按钮处);② emoji 换 lucide:🚀→`Rocket`、⚖️→`Scale`、🎯→`Crosshair`(避开 `Zap`/`Target`——已被评分行占用,复用会语义冲突),`h-4 w-4 text-muted-foreground` 与标题基线对齐。

**备选方案**:页面顶部集中图例区——离数据远,扫视时对不上号,弃;emoji 保留(mac 渲染尚可)——Windows 上观感差且与全应用 lucide 体系断裂(5.4 图标双体系问题),弃。

### 决策 #4:VAD 预设三档数值(有据)

**问题**:设置页六个裸数字输入无预设(6.6.1);「最大语音持续时间 0」无语义说明(6.6.2)。三档数值不能拍脑袋。

**采用方案:环境导向三档 + 数值取自上游文档。**

| 档位           | threshold | minSpeech(ms) | minSilence(ms) | maxSpeech(s) | pad(ms) | overlap(s) | 依据                                                                            |
| -------------- | --------- | ------------- | -------------- | ------------ | ------- | ---------- | ------------------------------------------------------------------------------- |
| 安静环境(灵敏) | 0.35      | 100           | 100            | 0            | 50      | 0.1        | silero/faster-whisper 指南:0.3-0.4 适合安静/远场拾音;minSpeech 100 保留短语气词 |
| 标准(推荐)     | 0.5       | 250           | 100            | 0            | 30      | 0.1        | whisper.cpp 官方默认值(与项目现默认一致)                                        |
| 嘈杂环境(严格) | 0.65      | 400           | 150            | 0            | 50      | 0.1        | whisper.rn 文档 noisyEnv 推荐:0.65/400/150/pad50                                |

档位命名用「环境导向」(安静环境/标准/嘈杂环境)而非报告原文的「保守/标准/激进」——「激进」对 VAD 是收得更严还是放得更松存在两可解读,环境命名零歧义,用户按音频实际环境选即可。交互:预设按钮行(三个 outline 按钮,当前六值与某档完全相等时高亮该档)+「恢复默认」按钮(=标准档);点击批量更新六个输入并走现有 500ms debounce 保存。`vadMaxSpeechDuration` 的 tooltip 文案明确「0 表示不限制」。

**顺手修复**:settings.tsx 加载回填用 `settings.vadThreshold || 0.5` 的 `||` 回退——存储值为 0 时 UI 失真显示默认值(threshold=0 虽不合理但 samplesOverlap=0 合法),统一改 `??`。

**备选方案**:滑杆替换数字输入(报告 6.6.1 提议)——改动面大且六个参数单位/量纲各异,预设档已消解「不知道填什么」的核心痛点,滑杆留作后续打磨,弃(本批)。

### 决策 #5:模型下载失败提示路径

**问题**:下载失败用户侧零提示(6.5.4)。探索发现根因:主进程 handler catch 后 `return { success:false, error }` 而非抛出,渲染层 `catch` 永不触发,真正的失败路径(`result.success === false`)什么都不做。

**采用方案**:① `DownModel.tsx` 在 `result.success === false` 分支 toast.error(区分 `anotherDownloadInProgress`→「已有下载进行中」与其他→「下载失败:{error}」);② `DownModelButton.tsx` 增加失败态:`detail?.status === 'error'` 且非 loading 时按钮变为「重试」(RefreshCw 图标,样式仿 GpuAccelerationCard 重试先例),点击即重新触发下载;③ 区分用户取消:`status==='idle'` + error 'Download cancelled' 不算失败,不提示。与 B13 全局 pill 的 error 态(红色 5s)语义一致。

**备选方案**:只改 catch 分支——根因在 success:false 返回,catch 改了也不触发,无效,弃;主进程改为 throw——会破坏现有调用方对返回值结构的依赖(OnboardingDialog/ModelsTab 都读 result.success),弃。

### 决策 #6:语向检测去硬编码

**问题**:导入字幕语向判定 `lang === 'en' ? 'source' : 'translated'` 假定英语永远是源语言,中→英用户完全反了(6.3.18)。同样的硬编码共 4 处(ProofreadImport、ProofreadFileList、proofreadUtils、main/subtitleDetector)。

**采用方案:用户任务语向优先,en=source 兜底,集中为单一工具函数。**新增 `classifySubtitleLang(lang, sourceLanguage?, targetLanguage?)`:检测语言 = 用户配置的 sourceLanguage → 'source';= targetLanguage → 'translated';都不匹配回退现有启发式(en→source,其他→translated);无检测结果 → 'unknown'。renderer 三处调用点从 userConfig 取语向传入(已有 getUserConfig IPC);main 侧 subtitleDetector 直接读 store userConfig。定位是「预填+可改」(用户仍可在下拉手动改),不追求全自动正确。

**备选方案**:内容级语言检测库(franc 等)——新依赖+对短字幕准确率有限,且文件名检测已覆盖主流命名习惯,过度工程,弃;只改 renderer 不改 main——main 的 matchSubtitleFiles 配对路径同样硬编码,改一半语义分裂,弃。

### 决策 #7:黄色警告语气校准

**问题**:「已自动切换到 CPU」在「自动(推荐)」模式下是设计内行为,黄色 AlertTriangle 语气过重(6.5.14);同卡「闪退提示」常驻黄块同理。

**采用方案**:`deriveStatus` 的两个 yellow 分支(CPU 回退、非首选后端回退)在 `gpuMode === 'auto'` 时降为 `neutral` tone(`bg-muted/40` + `Info` 图标,沿用同文件中性条先例),标题文案不变,失败原因列表保留展示;用户显式选了 GPU 模式却落到回退时仍保持 yellow(此时是用户预期外)。常驻「闪退提示」黄块改 `bg-muted/50` + Info 中性样式。

**备选方案**:全部降中性——用户手选 CUDA 却跑 CPU 属于预期违背,该警示就警示,弃;新增蓝色 info 色阶——项目无蓝色信息条先例,引入新色阶违背 B9 设计 token 收敛方向,弃。

### 决策 #8:格式提示与文件选择器统一

**问题**:文案写「支持 MP4, AVI, MKV, MOV, MP3, WAV / 字幕 SRT」,实际支持 29 种媒体 + 5 种字幕(4.4);且点击上传对话框只放行 9 种视频(不含任何音频),与拖拽行为不一致——同一能力两条入口两种结果。

**采用方案**:① 文案按类别概括:「支持 MP4 / MKV / MOV 等 29 种常见视频与音频格式」「支持 SRT / VTT / ASS / SSA / LRC 字幕」(不动态生成——renderer 无法 import main 常量,数字写死但语义按类别,小幅演进可接受);② `selectFile`/`selectFiles` 对话框的 extensions 改用 `MEDIA_EXTENSIONS` 全量(去掉 `.` 前缀),让两条入口行为一致。

**备选方案**:新增 IPC 动态取格式清单生成文案——为一行静态文案引入运行时链路,过度工程,弃;只改文案不改对话框——「文案说支持 MP3,点上传却选不了 MP3」直接打脸,必须一起改,弃。

### 决策 #9:「完成率」语义

**问题**:「完成率 2%」实为「已翻译比例」,校对场景被误读为校对进度(6.3.15)。

**采用方案**:VideoInfo 统计区合并重复行:删去独立的「已翻译: N」行,percent 行改为「已翻译 {withTranslation}/{total}({percent}%)」,key `completionRate` 文案改「已翻译」/en「Translated」。语义自明且少一行。

**备选方案**:增加真正的「已校对 N/M」统计——需要行级「已校对」标记数据模型(当前不存在),属新功能超出文案修正范围,弃(可进 backlog)。

### 决策 #10:「当前字幕」卡移除方式

**问题**:校对编辑器左栏「当前字幕」卡与右侧列表当前行高亮、播放器内字幕三重冗余,未播放时常显「无当前字幕」占位(6.3.14)。

**采用方案 A:直接删卡,依赖既有原生字幕轨。**探索确认 VideoPlayer 已传 VTT 轨(译文轨 default,无译文则原文轨 default),浏览器原生渲染——**视频画面内本来就有字幕在显示**,删卡后体验无损;原生 controls 的 CC 按钮还能切轨。同步清理:`CurrentSubtitle.tsx` 删除、ProofreadEditor 中仅供它的 `currentTime`/`hasTranslationFile` 解构移除、`currentSubtitle`/`noCurrentSubtitle` i18n 死键删除(zh/en)。左栏垂直空间还给播放器。

**备选方案 B:自绘双语浮层(复用合成页 SubtitlePreviewOverlay 模式)+ 隐藏原生轨**——双语同显体验更好,但需处理原生轨与浮层双重显示、cue 查找、样式适配,而右侧列表当前行已提供双语对照,增量价值小于增量复杂度(YAGNI),弃;若用户评审后想要双语浮层,可在此基础上加。

### 决策 #11:概览整卡可点交互

**问题**:资源中心概览三卡只有小字「管理 →」可点,点击目标小(6.5.18-19)。

**采用方案**:整卡 onClick → `onNavigateTab(tab)`,加 `cursor-pointer` + hover 视觉反馈(`hover:shadow-md transition-shadow`,仿启动台卡);a11y 比照 B12 标准:`role="button"` + `tabIndex={0}` + Enter/Space 触发;卡内已有交互元素(模型下载按钮等)`stopPropagation` 防冒泡(启动台最近任务行先例);「管理 →」按钮保留(变为冗余入口,视觉锚点价值仍在)。

**备选方案**:整卡包 `<Link>`——onNavigateTab 走 query replace 而非路由跳转,包 Link 会破坏 tab 状态管理,弃;移除「管理」按钮——它是「可点」的视觉提示,删了发现性反而降,弃。

## 范围外(明确不做)

- 滑杆化 VAD 输入(决策 #4 备选,后续打磨)。
- 「已校对 N/M」新统计模型(决策 #9 备选,backlog)。
- 双语自绘浮层(决策 #10 备选,等用户评审定夺)。
- `useSubtitles.ts` 死 hook 清理——它仍是 5 个组件的类型唯一来源,动它属重构非收尾,留 B15 后评估。

## 验收标准

1. 历史工程状态不随全局配置改变(改全局 provider 后启动台状态稳定);
2. 校对页匹配度数字、ModelsTab 圆点/档位图标均有解释,无裸数字/emoji;
3. VAD 三档预设一键应用且与手动微调共存,0 值语义有说明,threshold=0 回填不失真;
4. 模型下载失败有 toast + 行内重试,取消不报错;
5. 语向判定遵循用户任务语向(zh→en 用户导入中文字幕识别为原文);
6. 自动模式下 GPU 回退提示为中性信息,手动模式保持警示;
7. 上传对话框可选音频文件,格式文案与实际能力一致;
8. 校对编辑器左栏无「当前字幕」卡,播放器内字幕正常显示;
9. 概览三卡整卡可点且键盘可达;
10. 三项门禁全绿(i18n 对等、renderer 非测试 0、main ≤95)。
