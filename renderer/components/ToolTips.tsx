import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Info } from 'lucide-react';

const ToolTips = ({ text }) => {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger>
          <Info className="h-4 w-4 ml-2" />
        </TooltipTrigger>
        <TooltipContent>
          <p dangerouslySetInnerHTML={{ __html: text }} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export default ToolTips;
