import React from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import type { TranscriptionEngine } from '../../../../types/engine';

type ManageTarget = TranscriptionEngine | 'base';

interface EngineManageDrawerProps {
  target: ManageTarget | null;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}

/** 右侧引擎管理抽屉：承载某个引擎的全部配置面板。 */
const EngineManageDrawer: React.FC<EngineManageDrawerProps> = ({
  target,
  onOpenChange,
  title,
  description,
  children,
}) => {
  return (
    <Sheet open={target !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="mt-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
};

export default EngineManageDrawer;
