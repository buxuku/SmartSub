import React from 'react';
import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero', styles.heroBanner)}>
      <div className="container">
        <div className={styles.heroContent}>
          <div className={styles.heroText}>
            <Heading as="h1" className={styles.heroTitle}>
              妙幕 / <span className={styles.heroHighlight}>SmartSub</span>
            </Heading>
            <p className={styles.heroSubtitle}>{siteConfig.tagline}</p>
            <p className={styles.heroDescription}>
              让每一帧画面都能美妙地表达，批量处理视频字幕，实现多语言翻译
            </p>
            <div className={styles.buttons}>
              <Link
                className={clsx('button button--primary button--lg', styles.buttonPrimary)}
                to="/docs/intro">
                立即开始
              </Link>
              <Link
                className={clsx('button button--outline button--lg', styles.buttonSecondary)}
                to="https://github.com/buxuku/SmartSub/releases">
                下载软件
              </Link>
            </div>
          </div>
          <div className={styles.heroImage}>
            <img src="/SmartSub/img/hero-illustration.png" alt="SmartSub 界面预览" />
          </div>
        </div>
      </div>
    </header>
  );
}

function HomepageWorkflow() {
  return (
    <section className={styles.workflow}>
      <div className="container">
        <div className={styles.sectionHeader}>
          <Heading as="h2" className={styles.sectionTitle}>简单易用的工作流程</Heading>
          <p className={styles.sectionSubtitle}>只需几步，轻松生成高质量字幕并翻译</p>
        </div>
        <div className={styles.workflowSteps}>
          <div className={styles.workflowStep}>
            <div className={styles.stepNumber}>1</div>
            <Heading as="h3" className={styles.stepTitle}>导入媒体文件</Heading>
            <p className={styles.stepDescription}>选择本地视频或音频文件，支持多种常见格式</p>
          </div>
          <div className={styles.workflowStep}>
            <div className={styles.stepNumber}>2</div>
            <Heading as="h3" className={styles.stepTitle}>生成字幕</Heading>
            <p className={styles.stepDescription}>使用先进的AI模型，快速生成高准确度字幕</p>
          </div>
          <div className={styles.workflowStep}>
            <div className={styles.stepNumber}>3</div>
            <Heading as="h3" className={styles.stepTitle}>翻译内容</Heading>
            <p className={styles.stepDescription}>选择目标语言，一键将字幕翻译成多种语言</p>
          </div>
          <div className={styles.workflowStep}>
            <div className={styles.stepNumber}>4</div>
            <Heading as="h3" className={styles.stepTitle}>导出字幕</Heading>
            <p className={styles.stepDescription}>以多种格式导出字幕文件，随时应用到您的视频中</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function HomepagePlatforms() {
  return (
    <section className={styles.platforms}>
      <div className="container">
        <div className={styles.sectionHeader}>
          <Heading as="h2" className={styles.sectionTitle}>多平台支持</Heading>
          <p className={styles.sectionSubtitle}>适配多种设备，发挥硬件最大性能</p>
        </div>
        <div className={styles.platformCards}>
          <div className={styles.platformCard}>
            <div className={styles.platformIcon}>
              <i className="fas fa-windows"></i>
            </div>
            <Heading as="h3" className={styles.platformTitle}>Windows</Heading>
            <p className={styles.platformDescription}>
              支持NVIDIA CUDA加速，为不同显卡提供优化版本
            </p>
          </div>
          <div className={styles.platformCard}>
            <div className={styles.platformIcon}>
              <i className="fas fa-apple"></i>
            </div>
            <Heading as="h3" className={styles.platformTitle}>macOS</Heading>
            <p className={styles.platformDescription}>
              针对Apple Silicon芯片优化，支持CoreML硬件加速
            </p>
          </div>
          <div className={styles.platformCard}>
            <div className={styles.platformIcon}>
              <i className="fas fa-linux"></i>
            </div>
            <Heading as="h3" className={styles.platformTitle}>Linux</Heading>
            <p className={styles.platformDescription}>
              适配多种Linux发行版，支持CUDA加速
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function HomepageCTA() {
  return (
    <section className={styles.cta}>
      <div className="container">
        <div className={styles.ctaContent}>
          <Heading as="h2" className={styles.ctaTitle}>
            开始使用妙幕，释放创作新可能
          </Heading>
          <p className={styles.ctaDescription}>
            告别繁琐的字幕制作流程，专注于创意表达
          </p>
          <div className={styles.ctaButtons}>
            <Link
              className={clsx('button button--primary button--lg', styles.buttonPrimary)}
              to="/docs/intro">
              查看使用指南
            </Link>
            <Link
              className={clsx('button button--outline button--lg', styles.buttonSecondary)}
              to="https://github.com/buxuku/SmartSub">
              <i className="fab fa-github"></i> Star on GitHub
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} - 智能音视频字幕解决方案`}
      description="智能音视频字幕生成与多语言翻译批量化解决方案，支持多种视频/音频格式，本地处理保护隐私。">
      <HomepageHeader />
      <main>
        <HomepageFeatures />
        <HomepageWorkflow />
        <HomepagePlatforms />
        <HomepageCTA />
      </main>
    </Layout>
  );
}
