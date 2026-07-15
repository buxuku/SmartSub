## 1. 类型与画质映射表

- [x] 1.1 `types/subtitleMerge.ts`：新增 `EncoderMode`（`'cpu' | 'hardware'`）、`MergeConfig.encoderMode?`（缺省 cpu）、`HwAccelInfo`（`available/encoderId/encoderLabel/rateMode/platformSupported`）类型
- [x] 1.2 `types/subtitleMerge.ts`：与 `VIDEO_QUALITY_CRF` 并列定义硬件编码器画质映射表（nvenc cq 19/21/24、qsv global_quality 19/21/24、VT q:v 65/58/50、VT 码率系数 1.0/0.85/0.65）及各自 4K 偏移值，注明为实现期校准初值

## 2. 主进程：硬件编码器探测

- [x] 2.1 新建 `main/helpers/hwEncoderDetector.ts`：黑帧试编码探测（`lavfi color=black:s=640x360:d=0.1` → `-f null`，execFile 打包 ffmpeg，带超时），按平台生成候选（darwin: videotoolbox；win32: nvenc > qsv；linux: 空）
- [x] 2.2 探测带目标画质参数：VT 先 `-q:v` 试编码、失败再码率参数试编码（通过则 rateMode=bitrate）；qsv 用 `-global_quality`，失败即不可用；nvenc 用 `-rc vbr -cq`
- [x] 2.3 会话级内存缓存（Promise 缓存避免并发重复探测），探测过程与结果写日志（logMessage）
- [x] 2.4 `ipcSubtitleMergeHandlers.ts` 注册 `subtitleMerge:getHwAccelInfo`，返回探测结果；`preload` 无需改动（走既有 invoke 通道）

## 3. 主进程：烧录编码分支

- [x] 3.1 `subtitleMerger.ts`：hardcode 分支按 `encoderMode` 解析编码器——cpu/未传/探测不可用 → libx264 现状参数；hardware → 探测缓存编码器 + 映射表参数（含 4K 偏移；VT 码率模式按 `VideoInfo.size×8/duration×0.85` 估算并按分辨率钳位，估算失败回落 libx264 并记日志）
- [x] 3.2 硬件路径滤镜链末尾追加 `format=nv12`（CPU 路径不变）；日志记录实际编码器、档位与最终参数
- [x] 3.3 自动回退：硬件合成 error 且非 `mergeCancelled` 时，清理半成品 → warning 日志 → 通过进度事件通知渲染层「已切换 CPU 重试」→ libx264 从头重跑一次（仅一次）；取消与二次失败按既有流程

## 4. 渲染层：编码方式控件与提示

- [x] 4.1 `useSubtitleMerge.ts`：新增 `encoderMode` 状态与 `hwAccelInfo` 状态（挂载时异步 invoke 探测），`startMerge` 组装 `encoderMode` 进 MergeConfig；监听回退通知事件用于界面提示
- [x] 4.2 `MergeButton.tsx`：新增「编码方式」分段控件（复用输出方式分段样式），仅 hardcode 显示、Linux（platformSupported=false）隐藏、探测不可用/未返回时硬件项禁用 + tooltip 说明（含探测到的编码器名）
- [x] 4.3 体积提示：分段控件 tooltip 常驻速度/体积权衡说明；选中硬件时行动条内联提示（复用 outputPathRequiredHint 样式先例）
- [x] 4.4 `renderer/public/locales/{zh,en}/subtitleMerge.json`：编码方式、tooltip、体积提示、不可用原因、回退提示等全部文案

## 5. 合成偏好持久化

- [x] 5.1 store 定义 `mergePreferences: { outputMode, videoQuality, encoderMode }`（`main/helpers/store/` types + 默认值）
- [x] 5.2 `useSubtitleMerge.ts` 挂载时读取恢复、变更即写；持久化为 hardware 但本会话不可用时 UI 回落 CPU 显示且不改写存储值

## 6. 验证与校准

- [x] 6.1 mac（Apple Silicon）实测：探测返回 VT/cq、烧录成功、体积与 libx264 对比记录；同素材三档位观感/体积对比，必要时微调映射初值（±2）
      ↳ 2026-07-14 本机验证（与代码同形状命令）：VT `-q:v` 探测通过；1080p/20s 素材三档烧录成功、字幕渲染正确；体积 VT q65/58/50=19.0/14.4/9.5MB vs x264 CRF18/20/23=20.6/17.5/12.8MB；速度 3.3s vs 5.8s（CPU 占用 89% vs 447%）；合成素材下映射初值合理，真实素材校准待应用内复核
- [ ] 6.2 Windows 实测（N 卡 / Intel 核显各一台）：nvenc/qsv 探测与烧录、无独显机器禁用态、10-bit 源经 format=nv12 正常
      ↳ 需 Windows 真机；本机（mac）已验证 nvenc 参数被拒时探测判定失败路径正常（`Option not found` → 不可用）
- [ ] 6.3 回退路径验证：人为制造硬件编码失败（如伪造编码器参数）确认自动回退 libx264 完成且界面有提示；取消不触发回退
      ↳ 需应用内注入失败（如临时把 HW_QUALITY_MAPPING 的 VT q:v 改为非法值 999 再合成）；逻辑评审已过，待 dev 环境人工验证
- [ ] 6.4 Intel Mac（或模拟 `-q:v` 探测失败）验证码率模式：码率估算、钳位、输出体积≈预期；估算失败回落 libx264
      ↳ 2026-07-14 命令级模拟已过：VT 码率模式探测/烧录成功，1080p 源 7.28Mbps×0.85→目标 6.12Mbps，输出 14.8MB≈理论值；Intel 真机 e2e 待验证
- [ ] 6.5 持久化验证：偏好跨重启恢复；lint/tsc 通过（`npx tsc --noEmit`）
      ↳ tsc/lint 已过（改动文件 0 错误；根 tsc 既有无关错误不受影响）；跨重启恢复待应用内验证
