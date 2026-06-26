/**
 * longgap 真机回归的「单一数据源」：三语种（zh / en / ja）朗读脚本 + 句间长静音布局 + say 音色。
 *
 * 由 `gen-audio.ts` 用 macOS `say` +（项目自带）ffmpeg 合成 16k 单声道 WAV，`run.ts` 消费。
 * 句间用 `[[slnc ms]]`（macOS say 内联静音指令）插入 4–7s 长静音，复刻「说话—长停顿—说话」
 * 场景，用于验证内置 whisper.cpp 0-fork 时间轴管道在多语种下的：
 *   ① 句间停顿还原（gaps）  ② 深静音不产生幻觉（inSilence）  ③ 无「文本正常但一闪而过」过短 cue。
 */
export interface LongGapSentence {
  /** 朗读文本（被 say 合成为语音）。 */
  text: string;
  /** 本句朗读后插入的静音毫秒数（句间长停顿；末句即尾部静音）。 */
  silenceMs: number;
}

export interface LongGapFixture {
  /** whisper 语言代码（zh / en / ja）。 */
  lang: string;
  /** 人类可读语言名（仅日志用）。 */
  label: string;
  /** macOS `say` 音色（`say -v '?'` 可列出；非 mac 不可用）。 */
  sayVoice: string;
  sentences: LongGapSentence[];
}

export const LONGGAP_FIXTURES: LongGapFixture[] = [
  {
    lang: 'zh',
    label: '中文',
    sayVoice: 'Tingting',
    sentences: [
      { text: '大家好，欢迎使用智能字幕语音识别测试音频。', silenceMs: 4000 },
      { text: '这段录音用于验证中文识别效果。', silenceMs: 5000 },
      {
        text: '今天是二零二六年六月二十五日，星期四，天气晴朗，气温二十八度。',
        silenceMs: 6000,
      },
      {
        text: '请记录以下信息，订单号是 A 一二三四五六七，电话号码是 一三八零零一三八零零。',
        silenceMs: 5000,
      },
      {
        text: '人工智能技术正在快速发展，语音识别、机器翻译和自然语言处理得到广泛应用。',
        silenceMs: 7000,
      },
      {
        text: '会议将在下午三点半，在二楼第二会议室召开，请准时参加。',
        silenceMs: 6000,
      },
      {
        text: '测试内容到此结束，感谢聆听，祝您工作顺利，生活愉快，再见。',
        silenceMs: 1000,
      },
    ],
  },
  {
    lang: 'en',
    label: 'English',
    sayVoice: 'Samantha',
    sentences: [
      {
        text: 'Hello everyone. Welcome to the smart subtitle speech recognition test audio.',
        silenceMs: 4000,
      },
      {
        text: 'This recording is used to verify English recognition.',
        silenceMs: 5000,
      },
      {
        text: 'Today is June 25, 2026. It is Thursday and the weather is clear. The temperature is 28 degrees.',
        silenceMs: 6000,
      },
      {
        text: 'Please record the following information. The order number is A1234567. The phone number is 1380013800.',
        silenceMs: 5000,
      },
      {
        text: 'Artificial intelligence technology is developing rapidly. Speech recognition, machine translation and natural language processing are widely used.',
        silenceMs: 7000,
      },
      {
        text: 'This meeting will be held at half past three in the afternoon, in the second meeting room on the second floor. Please attend on time.',
        silenceMs: 6000,
      },
      {
        text: 'The test content ends here. Thank you for listening. I wish you good work and a happy life. Goodbye.',
        silenceMs: 1000,
      },
    ],
  },
  {
    lang: 'ja',
    label: '日本語',
    sayVoice: 'Kyoko',
    sentences: [
      {
        text: '皆さん、こんにちは。スマート字幕音声認識テスト音声へようこそ。',
        silenceMs: 4000,
      },
      {
        text: 'この録音は日本語認識の効果を確認するために使います。',
        silenceMs: 5000,
      },
      {
        text: '今日は二〇二六年六月二十五日、木曜日です。天気は晴れ、気温は二十八度です。',
        silenceMs: 6000,
      },
      {
        text: '以上の情報を記録してください。注文番号は A 一二三四五六七です。電話番号は 一三八〇〇一三八〇〇です。',
        silenceMs: 5000,
      },
      {
        text: '人工知能技術は急速に発展しています。音声認識、機械翻訳、自然言語処理が広く利用されています。',
        silenceMs: 7000,
      },
      {
        text: '会議は午後三時半に二階の第二会議室で開催されます。時間通りにご参加ください。',
        silenceMs: 6000,
      },
      {
        text: 'テスト内容は以上です。ご清聴ありがとうございました。',
        silenceMs: 1000,
      },
    ],
  },
];

/** 把 fixture 拼成 `say` 输入串：句子之间插入 `[[slnc ms]]` 长静音。 */
export function buildSayInput(fix: LongGapFixture): string {
  return fix.sentences
    .map((s) => `${s.text} [[slnc ${s.silenceMs}]]`)
    .join(' ');
}

/** fixture 的「设计总静音秒数」（用于日志对照实际 VAD 检出的静音）。 */
export function designedSilenceSeconds(fix: LongGapFixture): number {
  return fix.sentences.reduce((a, s) => a + s.silenceMs, 0) / 1000;
}
