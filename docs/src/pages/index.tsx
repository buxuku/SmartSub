import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
// 导入React Icons
import {
  FaServer,
  FaLanguage,
  FaRocket,
  FaLayerGroup,
  FaCogs,
  FaMicrochip,
} from 'react-icons/fa';

import styles from './index.module.css';

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg"
            to="/intro/introduction"
          >
            开始使用 →
          </Link>
          <Link
            className="button button--outline button--lg button--secondary"
            to="/download"
          >
            立即下载
          </Link>
        </div>
      </div>
    </header>
  );
}

type FeatureItem = {
  title: string;
  icon: ReactNode;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: '本地化处理',
    icon: <FaServer className={styles.featureIcon} />,
    description: (
      <>
        无需上传视频，保护隐私的同时拥有更快的处理速度。
        在您的设备上完成全部字幕生成和翻译过程。
      </>
    ),
  },
  {
    title: '多语言翻译',
    icon: <FaLanguage className={styles.featureIcon} />,
    description: (
      <>
        支持多种翻译服务，包括火山引擎、百度翻译、DeepLX、
        微软翻译、Ollama本地模型及OpenAI风格API等。
      </>
    ),
  },
  {
    title: '硬件加速',
    icon: <FaRocket className={styles.featureIcon} />,
    description: (
      <>
        支持NVIDIA CUDA(Windows/Linux)和Apple Core ML(macOS M系列芯片)
        硬件加速，大幅提升处理速度。
      </>
    ),
  },
  {
    title: '批量处理',
    icon: <FaLayerGroup className={styles.featureIcon} />,
    description: (
      <>
        支持批量处理多个视频/音频文件，自动生成字幕。
        也可对生成或导入的字幕进行批量翻译。
      </>
    ),
  },
  {
    title: '自定义配置',
    icon: <FaCogs className={styles.featureIcon} />,
    description: (
      <>
        自定义字幕文件名，兼容不同播放器的字幕识别；
        支持纯翻译结果或原字幕+翻译结果的多种格式。
      </>
    ),
  },
  {
    title: '多模型支持',
    icon: <FaMicrochip className={styles.featureIcon} />,
    description: (
      <>
        支持多种whisper模型，从轻量级的tiny到高精度的large系列，
        平衡准确性与资源消耗。
      </>
    ),
  },
];

function Feature({ title, icon, description }: FeatureItem) {
  return (
    <div className="feature-card">
      <div className={styles.featureIconContainer}>{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

function HomepageFeatures() {
  return (
    <section className={styles.featuresSection}>
      <div className="container">
        <div className={styles.featuresHeading}>
          <Heading as="h2">强大功能，简单操作</Heading>
          <p>妙幕集成了多种强大功能，满足您的字幕生成和翻译需求</p>
        </div>
        <div className="features-container">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}

function HomepageScreenshot() {
  return (
    <section className={styles.section}>
      <div className="container">
        <Heading as="h2" className={styles.sectionTitle}>
          智能字幕生成与翻译解决方案
        </Heading>
        <p className={styles.sectionDescription}>
          妙幕(SmartSub)是一款强大的音视频字幕生成与多语言翻译工具，支持多种格式，本地化处理，并提供丰富的自定义选项。
        </p>
        <div className={styles.screenshotContainer}>
          <div className={styles.screenshotWrapper}>
            <img
              className="screenshot"
              src="/img/preview.png"
              alt="妙幕应用界面预览"
            />
            <div className={styles.screenshotOverlay}></div>
          </div>
        </div>
      </div>
    </section>
  );
}

function HomepageDemo() {
  return (
    <section className={styles.section}>
      <div className="container">
        <Heading as="h2" className={styles.sectionTitle}>
          简单易用的操作流程
        </Heading>
        <div className={styles.stepsContainer}>
          <div className={styles.step}>
            <div className={styles.stepNumber}>1</div>
            <h3>选择文件</h3>
            <p>导入视频、音频或字幕文件</p>
          </div>
          <div className={styles.step}>
            <div className={styles.stepNumber}>2</div>
            <h3>设置参数</h3>
            <p>选择模型、语言和翻译服务</p>
          </div>
          <div className={styles.step}>
            <div className={styles.stepNumber}>3</div>
            <h3>开始处理</h3>
            <p>自动完成字幕生成或翻译</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function CTASection() {
  return (
    <section className={styles.ctaSection}>
      <div className="container">
        <Heading as="h2">立即开始使用妙幕</Heading>
        <p>下载应用，开启智能字幕生成与翻译之旅</p>
        <div className={styles.ctaButtons}>
          <Link className="button button--primary button--lg" to="/download">
            下载软件
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="/intro/introduction"
          >
            查看文档
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} - 智能音视频字幕生成与翻译工具`}
      description="妙幕(SmartSub)是一款智能音视频字幕生成与多语言翻译的批量化解决方案，支持本地处理，多种翻译服务和硬件加速。"
    >
      <HomepageHeader />
      <main>
        <HomepageScreenshot />
        <HomepageFeatures />
        <HomepageDemo />
        <CTASection />
      </main>
    </Layout>
  );
}
