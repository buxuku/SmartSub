import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */
const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: '入门指南',
      items: ['intro/introduction', 'intro/installation', 'intro/quickstart'],
    },
    {
      type: 'category',
      label: '功能与特性',
      items: [
        'features/subtitle-generation',
        'features/subtitle-translation',
        'features/batch-processing',
      ],
    },
    {
      type: 'category',
      label: '模型与配置',
      items: [
        'configuration/models',
        'configuration/translation-services',
        'configuration/settings',
      ],
    },
    {
      type: 'category',
      label: '任务模式',
      items: [
        'tasks/audio-video-to-subtitle',
        'tasks/subtitle-translation',
        'tasks/batch-processing',
      ],
    },
    {
      type: 'category',
      label: '进阶使用',
      items: ['advanced/hardware-acceleration', 'advanced/custom-prompts'],
    },
    {
      type: 'doc',
      id: 'faq',
      label: '常见问题',
    },
  ],
};

export default sidebars;
