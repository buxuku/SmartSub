import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// Read version from root package.json
import * as fs from 'fs';
import * as path from 'path';

const rootPackageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
);
const appVersion = rootPackageJson.version;

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  // 站点 title 保持品牌名：各页面标题自带关键词，经「页面标题 | 站点名」拼接后不重复
  title: '妙幕 SmartSub',
  tagline: '让每一帧画面都能美妙地表达',
  favicon: 'img/favicon.ico',

  // Set the production url of your site here
  url: 'https://smartsub.linxiaodong.com',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'buxuku', // Usually your GitHub org/user name.
  projectName: 'SmartSub', // Usually your repo name.

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',

  // Custom fields to expose app version to components
  customFields: {
    appVersion,
  },

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'zh-Hans',
    locales: ['zh-Hans'],
  },

  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        // 站点重构后的旧路径重定向，保住已被收录页面的权重
        redirects: [
          { from: '/configuration/models', to: '/guides/engines/models' },
          {
            from: '/configuration/translation-services',
            to: '/guides/translation/overview',
          },
          { from: '/configuration/settings', to: '/advanced/storage' },
          { from: '/advanced/build-addon', to: '/development' },
          {
            from: '/tasks/audio-video-to-subtitle',
            to: '/features/subtitle-generation',
          },
          {
            from: '/tasks/subtitle-translation',
            to: '/features/subtitle-translation',
          },
          { from: '/tasks/batch-processing', to: '/intro/quickstart' },
        ],
      },
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl: 'https://github.com/buxuku/SmartSub/tree/main/docs/',
          routeBasePath: '/', // 将文档设置为首页
        },
        blog: false, // 不需要博客功能
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/smartsub-social-card.png',
    metadata: [
      {
        name: 'keywords',
        content:
          '视频转字幕,字幕生成软件,字幕翻译,AI 配音,声音克隆,视频转文字,语音转文字,字幕烧录,SRT,whisper,开源免费,SmartSub,妙幕',
      },
      { property: 'og:type', content: 'website' },
    ],
    navbar: {
      title: '妙幕 / SmartSub',
      logo: {
        alt: 'SmartSub Logo',
        src: 'img/icon.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: '使用文档',
        },
        {
          to: '/download',
          label: '下载软件',
          position: 'left',
        },
        {
          to: '/development',
          label: '开发说明',
          position: 'left',
        },
        {
          to: '/changelog',
          label: '更新日志',
          position: 'left',
        },
        {
          to: '/faq',
          label: '常见问题',
          position: 'left',
        },
        {
          href: 'https://github.com/buxuku/SmartSub',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: '文档',
          items: [
            {
              label: '使用文档',
              to: '/',
            },
            {
              label: '下载软件',
              to: '/download',
            },
            {
              label: '常见问题',
              to: '/faq',
            },
            {
              label: '代码签名策略（Code signing policy）',
              to: '/code-signing-policy',
            },
          ],
        },
        {
          title: '社区',
          items: [
            {
              label: 'QQ 交流群',
              href: 'https://github.com/buxuku/SmartSub#社区与支持',
            },
            {
              label: '问题反馈',
              href: 'https://github.com/buxuku/SmartSub/issues',
            },
          ],
        },
        {
          title: '更多',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/buxuku/SmartSub',
            },
            {
              label: '赞助合作',
              to: '/sponsorship',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} 妙幕 / SmartSub. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
