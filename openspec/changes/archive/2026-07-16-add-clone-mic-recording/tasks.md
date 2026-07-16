# Tasks: add-clone-mic-recording

- [x] 1.1 main：`voiceClone:saveRecording`（Uint8Array → temp `voice-clone/rec-<ts>.webm`，返回路径）+ `voiceClone:requestMicAccess`（darwin askForMediaAccess，其余平台直通）
- [x] 1.2 `electron-builder.yml`：mac `extendInfo.NSMicrophoneUsageDescription`
- [x] 1.3 renderer：`MicRecorder` 组件（getUserMedia/MediaRecorder + AnalyserNode 电平条 + 计时 + 5min 上限 + 试听/重录/确认；采集关闭浏览器级降噪/AEC/AGC 保真）
- [x] 1.4 向导 Step1 第三入口 + 朗读脚本卡（zh/en 各一段，目标时长按引擎提示 15/30/60s）；确认后走 `saveRecording → startAnalyze`
- [x] 1.5 权限拒绝 UI（系统设置指引）+ i18n（zh/en）
- [x] 1.6 回归：check:i18n ✓ / build ✓；webm/opus（MediaRecorder 同容器）→ analyze 管线冒烟通过（5 语音段、推荐区 verdict good）；真机 mac 权限弹窗与实录链路待用户验证
