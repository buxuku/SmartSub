import type {ReactNode} from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

// 导入图标
import SubtitleIcon from '@site/static/img/features/subtitle.svg';
import TranslateIcon from '@site/static/img/features/translate.svg';
import PrivacyIcon from '@site/static/img/features/privacy.svg';
import MultiServiceIcon from '@site/static/img/features/multi-service.svg';
import HardwareIcon from '@site/static/img/features/hardware.svg';
import CustomizeIcon from '@site/static/img/features/customize.svg';

type FeatureItem = {
  title: string;
  Svg: React.ComponentType<React.ComponentProps<'svg'>>;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: '多格式字幕生成',
    Svg: SubtitleIcon,
    description: (
      <>
        支持多种视频/音频格式文件，轻松生成高精度字幕，让内容创作更加高效。
      </>
    ),
  },
  {
    title: '强大的翻译能力',
    Svg: TranslateIcon,
    description: (
      <>
        支持对生成的字幕或导入的字幕进行多语言翻译，实现内容的全球化传播。
      </>
    ),
  },
  {
    title: '本地化隐私保护',
    Svg: PrivacyIcon,
    description: (
      <>
        无需上传视频，本地处理保护您的隐私，同时提供更快的处理速度与更好的安全性。
      </>
    ),
  },
  {
    title: '多种翻译服务',
    Svg: MultiServiceIcon,
    description: (
      <>
        集成火山引擎、百度翻译、微软翻译器、DeepLX、Ollama等多种翻译服务，满足不同需求。
      </>
    ),
  },
  {
    title: '硬件加速支持',
    Svg: HardwareIcon,
    description: (
      <>
        支持NVIDIA CUDA和Apple Core ML硬件加速，极大提升处理速度，体验流畅无比。
      </>
    ),
  },
  {
    title: '灵活自定义选项',
    Svg: CustomizeIcon,
    description: (
      <>
        自定义字幕文件名和内容格式，支持自定义并发任务数量，满足专业用户的进阶需求。
      </>
    ),
  },
];

function Feature({title, Svg, description}: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
      <div className={styles.featureCard}>
        <div className={styles.featureIconContainer}>
          <Svg className={styles.featureSvg} role="img" />
        </div>
        <div className={styles.featureContent}>
          <Heading as="h3" className={styles.featureTitle}>{title}</Heading>
          <p className={styles.featureDescription}>{description}</p>
        </div>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className={styles.featuresHeader}>
          <Heading as="h2" className={styles.featuresTitle}>核心特性</Heading>
          <p className={styles.featuresSubtitle}>妙幕提供全方位的字幕解决方案，解放您的创作力</p>
        </div>
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
