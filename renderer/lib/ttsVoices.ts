/**
 * 本地 TTS 模型内置音色静态表（阶段 A · 任务 1.5）。
 *
 * 数据来源（不随运行时变化，固化为静态数据）：
 * - kokoro-multi-lang-v1_1：103 音色。sid 顺序 = HF hexgrad/Kokoro-82M-v1.1-zh
 *   voices/ 目录字典序（af_* 美音女 → bf_* 英音女 → zf_* 中文女 → zm_* 中文男），
 *   与 sherpa-onnx voices.bin 打包顺序一致（冒烟实测 numSpeakers=103 吻合）。
 * - vits-zh-aishell3：174 音色。sid = 模型包 speakers.txt 行号（0-based），
 *   名称 = AISHELL-3 说话人 ID；性别/年龄/口音来自官方 spk-info.txt（aishell3SpeakerMeta.json）。
 */

import aishell3SpeakerMeta from './aishell3SpeakerMeta.json';

export type Aishell3AgeGroup = 'A' | 'B' | 'C' | 'D';
export type Aishell3Accent = 'north' | 'south' | 'others';

export interface Aishell3SpeakerMeta {
  age: Aishell3AgeGroup;
  gender: 'female' | 'male';
  accent: Aishell3Accent;
}

const AISHELL3_SPEAKER_META = aishell3SpeakerMeta as Record<
  string,
  Aishell3SpeakerMeta
>;

export interface TtsVoice {
  sid: number;
  /** 原始音色名（af_maple / zf_001 / SSB0005）。 */
  name: string;
  /** kokoro 可从命名推断；aishell3 无元数据，缺省 undefined。 */
  gender?: 'female' | 'male';
  /** 主语言（BCP-47 主标签）。kokoro 中文音色亦可读英文（espeak 回落），按主语言标注。 */
  language: 'zh' | 'en';
}

/** kokoro v1.1-zh 音色名（sid 0..102，字典序与 voices.bin 一致）。 */
const KOKORO_NAMES = [
  'af_maple',
  'af_sol',
  'bf_vale',
  'zf_001',
  'zf_002',
  'zf_003',
  'zf_004',
  'zf_005',
  'zf_006',
  'zf_007',
  'zf_008',
  'zf_017',
  'zf_018',
  'zf_019',
  'zf_021',
  'zf_022',
  'zf_023',
  'zf_024',
  'zf_026',
  'zf_027',
  'zf_028',
  'zf_032',
  'zf_036',
  'zf_038',
  'zf_039',
  'zf_040',
  'zf_042',
  'zf_043',
  'zf_044',
  'zf_046',
  'zf_047',
  'zf_048',
  'zf_049',
  'zf_051',
  'zf_059',
  'zf_060',
  'zf_067',
  'zf_070',
  'zf_071',
  'zf_072',
  'zf_073',
  'zf_074',
  'zf_075',
  'zf_076',
  'zf_077',
  'zf_078',
  'zf_079',
  'zf_083',
  'zf_084',
  'zf_085',
  'zf_086',
  'zf_087',
  'zf_088',
  'zf_090',
  'zf_092',
  'zf_093',
  'zf_094',
  'zf_099',
  'zm_009',
  'zm_010',
  'zm_011',
  'zm_012',
  'zm_013',
  'zm_014',
  'zm_015',
  'zm_016',
  'zm_020',
  'zm_025',
  'zm_029',
  'zm_030',
  'zm_031',
  'zm_033',
  'zm_034',
  'zm_035',
  'zm_037',
  'zm_041',
  'zm_045',
  'zm_050',
  'zm_052',
  'zm_053',
  'zm_054',
  'zm_055',
  'zm_056',
  'zm_057',
  'zm_058',
  'zm_061',
  'zm_062',
  'zm_063',
  'zm_064',
  'zm_065',
  'zm_066',
  'zm_068',
  'zm_069',
  'zm_080',
  'zm_081',
  'zm_082',
  'zm_089',
  'zm_091',
  'zm_095',
  'zm_096',
  'zm_097',
  'zm_098',
  'zm_100',
];

/** aishell3 说话人 ID（sid 0..173，= speakers.txt 行号）。 */
const AISHELL3_NAMES = [
  'SSB0005',
  'SSB0009',
  'SSB0011',
  'SSB0012',
  'SSB0016',
  'SSB0018',
  'SSB0033',
  'SSB0038',
  'SSB0043',
  'SSB0057',
  'SSB0073',
  'SSB0080',
  'SSB0112',
  'SSB0122',
  'SSB0133',
  'SSB0139',
  'SSB0145',
  'SSB0149',
  'SSB0193',
  'SSB0197',
  'SSB0200',
  'SSB0241',
  'SSB0246',
  'SSB0261',
  'SSB0267',
  'SSB0273',
  'SSB0287',
  'SSB0288',
  'SSB0299',
  'SSB0307',
  'SSB0309',
  'SSB0315',
  'SSB0316',
  'SSB0323',
  'SSB0338',
  'SSB0339',
  'SSB0341',
  'SSB0342',
  'SSB0354',
  'SSB0366',
  'SSB0375',
  'SSB0379',
  'SSB0380',
  'SSB0382',
  'SSB0385',
  'SSB0393',
  'SSB0394',
  'SSB0395',
  'SSB0407',
  'SSB0415',
  'SSB0426',
  'SSB0427',
  'SSB0434',
  'SSB0435',
  'SSB0470',
  'SSB0482',
  'SSB0502',
  'SSB0534',
  'SSB0535',
  'SSB0539',
  'SSB0544',
  'SSB0565',
  'SSB0570',
  'SSB0578',
  'SSB0588',
  'SSB0590',
  'SSB0594',
  'SSB0599',
  'SSB0601',
  'SSB0603',
  'SSB0606',
  'SSB0607',
  'SSB0609',
  'SSB0614',
  'SSB0623',
  'SSB0629',
  'SSB0631',
  'SSB0632',
  'SSB0666',
  'SSB0668',
  'SSB0671',
  'SSB0686',
  'SSB0700',
  'SSB0710',
  'SSB0720',
  'SSB0723',
  'SSB0737',
  'SSB0746',
  'SSB0748',
  'SSB0751',
  'SSB0758',
  'SSB0760',
  'SSB0762',
  'SSB0778',
  'SSB0780',
  'SSB0784',
  'SSB0786',
  'SSB0794',
  'SSB0817',
  'SSB0851',
  'SSB0863',
  'SSB0871',
  'SSB0887',
  'SSB0913',
  'SSB0915',
  'SSB0919',
  'SSB0935',
  'SSB0966',
  'SSB0987',
  'SSB1008',
  'SSB1020',
  'SSB1024',
  'SSB1050',
  'SSB1055',
  'SSB1056',
  'SSB1064',
  'SSB1072',
  'SSB1091',
  'SSB1096',
  'SSB1100',
  'SSB1108',
  'SSB1115',
  'SSB1125',
  'SSB1131',
  'SSB1136',
  'SSB1138',
  'SSB1161',
  'SSB1203',
  'SSB1204',
  'SSB1218',
  'SSB1221',
  'SSB1253',
  'SSB1320',
  'SSB1341',
  'SSB1366',
  'SSB1377',
  'SSB1383',
  'SSB1385',
  'SSB1392',
  'SSB1393',
  'SSB1408',
  'SSB1431',
  'SSB1437',
  'SSB1448',
  'SSB1555',
  'SSB1563',
  'SSB1567',
  'SSB1575',
  'SSB1585',
  'SSB1593',
  'SSB1607',
  'SSB1624',
  'SSB1625',
  'SSB1630',
  'SSB1650',
  'SSB1670',
  'SSB1684',
  'SSB1686',
  'SSB1699',
  'SSB1711',
  'SSB1759',
  'SSB1806',
  'SSB1828',
  'SSB1831',
  'SSB1832',
  'SSB1837',
  'SSB1846',
  'SSB1863',
  'SSB1878',
  'SSB1891',
  'SSB1918',
  'SSB1935',
  'SSB1939',
  'SSB1956',
];

function kokoroVoice(name: string, sid: number): TtsVoice {
  if (name.startsWith('zf_'))
    return { sid, name, gender: 'female', language: 'zh' };
  if (name.startsWith('zm_'))
    return { sid, name, gender: 'male', language: 'zh' };
  // af_* 美音女 / bf_* 英音女
  return { sid, name, gender: 'female', language: 'en' };
}

/** modelId → 音色全表（sid 即数组下标）。 */
export const TTS_VOICES: Record<string, TtsVoice[]> = {
  'kokoro-multi-lang-v1_1': KOKORO_NAMES.map(kokoroVoice),
  'vits-zh-aishell3': AISHELL3_NAMES.map((name, sid): TtsVoice => {
    const meta = AISHELL3_SPEAKER_META[name];
    return {
      sid,
      name,
      language: 'zh',
      gender: meta?.gender,
    };
  }),
};

/**
 * 每模型默认推荐音色（探索期试听主观筛选）：
 * - kokoro：zf_001（sid 3，清晰中文女声）；
 * - aishell3：SSB0005（sid 0）。
 */
export const TTS_DEFAULT_VOICE: Record<string, number> = {
  'kokoro-multi-lang-v1_1': 3,
  'vits-zh-aishell3': 0,
};

export function getTtsVoices(modelId: string): TtsVoice[] {
  return TTS_VOICES[modelId] ?? [];
}

export function getTtsDefaultVoice(modelId: string): number {
  return TTS_DEFAULT_VOICE[modelId] ?? 0;
}

export interface TtsVoiceGroup {
  key: string;
  /** i18n key suffix: tasks dubbing.{labelKey} / resources engines.tts.{labelKey} */
  labelKey: string;
  voices: TtsVoice[];
}

const KOKORO_LANG_ZH: Record<string, string> = {
  zh: '中文',
  enUs: '美式英语',
  enGb: '英式英语',
};
const AISHELL3_AGE_ZH: Record<Aishell3AgeGroup, string> = {
  A: '少年',
  B: '青年',
  C: '中年',
  D: '年长',
};
const AISHELL3_ACCENT_ZH: Record<Aishell3Accent, string> = {
  north: '北方口音',
  south: '南方口音',
  others: '其他口音',
};

/** 任务/资源页用语义化音色标签（分组内下拉项与已选展示）。 */
export function formatTtsVoiceLabel(
  v: TtsVoice,
  modelId?: string,
  tr?: (key: string) => string,
): string {
  const L = (key: string, fallback: string) => (tr ? tr(key) : fallback);

  if (modelId === 'kokoro-multi-lang-v1_1') {
    const parts: string[] = [];
    if (v.language === 'zh') {
      parts.push(L('voiceTraits.lang.zh', KOKORO_LANG_ZH.zh));
    } else if (v.name.startsWith('bf_')) {
      parts.push(L('voiceTraits.lang.enGb', KOKORO_LANG_ZH.enGb));
    } else {
      parts.push(L('voiceTraits.lang.enUs', KOKORO_LANG_ZH.enUs));
    }
    if (v.gender === 'female') {
      parts.push(L('voiceTraits.gender.female', '女声'));
    } else if (v.gender === 'male') {
      parts.push(L('voiceTraits.gender.male', '男声'));
    }
    const slug = v.name.replace(/^(af|bf|zf|zm)_/, '').replace(/_/g, ' ');
    parts.push(slug);
    return parts.join(' · ');
  }
  if (modelId === 'vits-zh-aishell3') {
    const meta = AISHELL3_SPEAKER_META[v.name];
    if (meta) {
      const gender = L(
        `voiceTraits.gender.${meta.gender}`,
        meta.gender === 'female' ? '女声' : '男声',
      );
      const age = L(`voiceTraits.age.${meta.age}`, AISHELL3_AGE_ZH[meta.age]);
      const accent = L(
        `voiceTraits.accent.${meta.accent}`,
        AISHELL3_ACCENT_ZH[meta.accent],
      );
      return `${gender} · ${age} · ${accent} · ${v.name}`;
    }
    return v.name;
  }
  return v.name;
}

/** 按语言/性别分组，便于下拉浏览。 */
export function groupTtsVoices(
  modelId: string,
  voices: TtsVoice[],
): TtsVoiceGroup[] {
  if (modelId === 'kokoro-multi-lang-v1_1') {
    return [
      {
        key: 'zhFemale',
        labelKey: 'voiceGroups.zhFemale',
        voices: voices.filter(
          (v) => v.language === 'zh' && v.gender === 'female',
        ),
      },
      {
        key: 'zhMale',
        labelKey: 'voiceGroups.zhMale',
        voices: voices.filter(
          (v) => v.language === 'zh' && v.gender === 'male',
        ),
      },
      {
        key: 'en',
        labelKey: 'voiceGroups.en',
        voices: voices.filter((v) => v.language === 'en'),
      },
    ].filter((g) => g.voices.length > 0);
  }
  if (modelId === 'vits-zh-aishell3') {
    return [
      {
        key: 'zhFemale',
        labelKey: 'voiceGroups.zhFemale',
        voices: voices.filter((v) => v.gender === 'female'),
      },
      {
        key: 'zhMale',
        labelKey: 'voiceGroups.zhMale',
        voices: voices.filter((v) => v.gender === 'male'),
      },
    ].filter((g) => g.voices.length > 0);
  }
  return [
    {
      key: 'all',
      labelKey: 'voiceGroups.zhSpeakers',
      voices,
    },
  ];
}
