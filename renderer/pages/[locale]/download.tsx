/**
 * 在线视频下载页：批量粘贴链接 → 预检 → 下载 → 交接任务流。
 */
import React from 'react';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import DownloadPanel from '@/components/download/DownloadPanel';

export default function DownloadPage() {
  return <DownloadPanel />;
}

export const getStaticProps = makeStaticProperties(['common', 'download']);
export { getStaticPaths };
