/**
 * 「保存源字幕文件」（`sourceSrtSaveOption`）在「仅生成字幕」任务里的修正规则。
 *
 * 渲染进程（任务页、设置面板、向导）和主进程（下载流水线）都要用同一条规则，
 * 所以这个模块不能有任何运行时依赖。
 */

/**
 * 「保存源字幕文件」的出厂默认是不保存（noSave）。「仅生成字幕」任务的源字幕就是最终交付物，
 * 停在 noSave 会让它以 `<视频名>_temp.srt` 落盘，播放器按同名加载不到；带翻译的任务里源字幕
 * 只是中间产物，不保存才是对的。所以每个创建「仅生成字幕」任务的入口都要把 noSave（或空值）
 * 读成 fileName：任务页改表单，向导与下载流水线在提交时改配置，面板只改显示（见 CommonSettings）。
 *
 * 返回该用的值；不需要修正（不是仅生成字幕，或者已经是有效选择）时返回 undefined。
 */
export function correctedSourceSrtSaveOption(
  taskType: string | undefined,
  option: unknown,
): 'fileName' | undefined {
  if (taskType !== 'generateOnly') return undefined;
  return !option || option === 'noSave' ? 'fileName' : undefined;
}
