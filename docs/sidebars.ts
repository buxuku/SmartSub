import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

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
  // By default, Docusaurus generates a sidebar from the docs folder structure
  tutorialSidebar: [
    'intro',
    {
      type: 'category',
      label: '入门指南',
      items: ['getting-started/installation', 'getting-started/download-models'],
    },
    {
      type: 'category',
      label: '基本功能',
      items: [
        'features/generate-subtitles',
        'features/translate-subtitles',
      ],
    },
    {
      type: 'category',
      label: '配置说明',
      items: [
        'configuration/interface-settings', 
        'configuration/translation-services', 
        'configuration/model-management',
      ],
    },
    {
      type: 'category',
      label: '高级功能',
      items: [
        'advanced/cuda-acceleration',
        'advanced/core-ml-acceleration',
        'advanced/custom-prompts',
      ],
    },
    {
      type: 'category',
      label: '常见问题',
      items: ['faq/troubleshooting'],
    },
  ],

  // But you can create a sidebar manually
  /*
  tutorialSidebar: [
    'intro',
    'hello',
    {
      type: 'category',
      label: 'Tutorial',
      items: ['tutorial-basics/create-a-document'],
    },
  ],
   */
};

export default sidebars;
