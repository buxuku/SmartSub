import React from 'react';
import { useRouter } from 'next/router';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import ToolboxHeader from '@/components/toolbox/ToolboxHeader';
import ToolboxDashboard from '@/components/toolbox/ToolboxDashboard';
import SubtitleConverterPanel from '@/components/toolbox/subtitleConverter/SubtitleConverterPanel';
import VideoTrimmerPanel from '@/components/toolbox/videoTrimmer/VideoTrimmerPanel';
import AudioExtractorPanel from '@/components/toolbox/audioExtractor/AudioExtractorPanel';
import EmbeddedSubtitlePanel from '@/components/toolbox/embeddedSubtitles/EmbeddedSubtitlePanel';
import SubtitleSyncPanel from '@/components/toolbox/subtitleSync/SubtitleSyncPanel';
import BilingualSubtitlePanel from '@/components/toolbox/bilingualSubtitles/BilingualSubtitlePanel';
import VideoCompressorPanel from '@/components/toolbox/videoCompressor/VideoCompressorPanel';
import VideoToGifPanel from '@/components/toolbox/videoToGif/VideoToGifPanel';
import type { ToolboxToolId } from '../../../types/toolbox';

export default function ToolboxPage() {
  const router = useRouter();
  const { tool } = router.query;
  const activeToolId = (typeof tool === 'string' ? tool : null) as ToolboxToolId | null;

  const handleSelectTool = (id: ToolboxToolId) => {
    router.push(
      {
        pathname: router.pathname,
        query: { ...router.query, tool: id },
      },
      undefined,
      { shallow: true },
    );
  };

  const handleBack = () => {
    const { tool: _, ...rest } = router.query;
    router.push(
      {
        pathname: router.pathname,
        query: rest,
      },
      undefined,
      { shallow: true },
    );
  };

  const renderActiveTool = () => {
    switch (activeToolId) {
      case 'subtitle-converter':
        return <SubtitleConverterPanel />;
      case 'video-trimmer':
        return <VideoTrimmerPanel />;
      case 'audio-extractor':
        return <AudioExtractorPanel />;
      case 'embedded-subtitles':
        return <EmbeddedSubtitlePanel />;
      case 'subtitle-sync':
        return <SubtitleSyncPanel />;
      case 'bilingual-subtitles':
        return <BilingualSubtitlePanel />;
      case 'video-compressor':
        return <VideoCompressorPanel />;
      case 'video-to-gif':
        return <VideoToGifPanel />;
      default:
        return <ToolboxDashboard onSelectTool={handleSelectTool} />;
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <ToolboxHeader activeToolId={activeToolId} onBack={handleBack} />
      <div className="flex-1 overflow-hidden min-h-0">
        {renderActiveTool()}
      </div>
    </div>
  );
}

export const getStaticProps = makeStaticProperties(['common', 'toolbox']);
export { getStaticPaths };
