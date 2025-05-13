import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: '妙幕 / SmartSub',
  tagline: '让每一帧画面都能美妙地表达',
  favicon: 'img/favicon.ico',

  // Set the production url of your site here
  url: 'https://smartsub.buxuku.com',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'buxuku', // Usually your GitHub org/user name.
  projectName: 'SmartSub', // Usually your repo name.

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'zh-Hans',
    locales: ['zh-Hans'],
  },

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
    // Replace with your project's social card
    image: 'img/smartsub-social-card.jpg',
    navbar: {
      title: '妙幕 / SmartSub',
      logo: {
        alt: 'SmartSub Logo',
        src: 'img/logo.svg',
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
          ],
        },
        {
          title: '社区',
          items: [
            {
              label: '微信交流群',
              href: '#',
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
