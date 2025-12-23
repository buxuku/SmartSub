import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'next-i18next';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import ProofreadImport from '@/components/proofread/ProofreadImport';
import ProofreadFileList from '@/components/proofread/ProofreadFileList';
import ProofreadEditor from '@/components/proofread/ProofreadEditor';
import ProofreadTaskList from '@/components/proofread/ProofreadTaskList';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProofreadTask } from '../../../types/proofread';
import { Plus, History } from 'lucide-react';
import {
  PendingFile,
  loadPendingFileFromItem,
  pendingFileToSaveFormat,
} from '@/lib/proofreadUtils';

// 工作流阶段
type WorkflowStage = 'import' | 'list' | 'edit';

// 重新导出 PendingFile 类型供其他组件使用
export type { PendingFile } from '@/lib/proofreadUtils';

export default function ProofreadPage() {
  const { t } = useTranslation('home');
  const [activeTab, setActiveTab] = useState<'new' | 'history'>('new');

  // 工作流状态
  const [stage, setStage] = useState<WorkflowStage>('import');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [currentEditIndex, setCurrentEditIndex] = useState<number>(-1);
  const [savedTaskId, setSavedTaskId] = useState<string | null>(null);
  const [taskName, setTaskName] = useState<string>('');
  const [importType, setImportType] = useState<'video' | 'subtitle'>('video');

  // 从历史任务加载
  const handleLoadTask = useCallback(async (task: ProofreadTask) => {
    // 使用工具函数为每个项目加载可用字幕
    const files: PendingFile[] = await Promise.all(
      task.items.map((item) => loadPendingFileFromItem(item)),
    );

    // 判断导入类型
    const hasVideo = task.items.some((item) => item.videoPath);
    setImportType(hasVideo ? 'video' : 'subtitle');

    setPendingFiles(files);
    setSavedTaskId(task.id);
    setTaskName(task.name);
    setStage('list');
    setActiveTab('new');
  }, []);

  // 导入完成后进入列表
  const handleImportComplete = useCallback(
    (files: PendingFile[], type: 'video' | 'subtitle') => {
      setPendingFiles(files);
      setSavedTaskId(null);
      setImportType(type);
      // 默认任务名为第一个文件名（去除扩展名）
      const defaultName = files[0]?.fileName?.replace(/\.[^.]+$/, '') || '';
      setTaskName(defaultName);
      setStage('list');
    },
    [],
  );

  // 开始校对某个文件
  const handleStartProofread = useCallback((index: number) => {
    setCurrentEditIndex(index);
    setPendingFiles((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], status: 'proofreading' };
      return next;
    });
    setStage('edit');
  }, []);

  // 标记完成，返回列表
  const handleMarkComplete = useCallback(() => {
    setPendingFiles((prev) => {
      const next = [...prev];
      next[currentEditIndex] = {
        ...next[currentEditIndex],
        status: 'completed',
      };
      return next;
    });
    setCurrentEditIndex(-1);
    setStage('list');
  }, [currentEditIndex]);

  // 返回列表（不标记完成）
  const handleBackToList = useCallback(() => {
    setCurrentEditIndex(-1);
    setStage('list');
  }, []);

  // 更新文件配置
  const handleUpdateFile = useCallback(
    (index: number, updates: Partial<PendingFile>) => {
      setPendingFiles((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], ...updates };
        return next;
      });
    },
    [],
  );

  // 删除文件
  const handleRemoveFile = useCallback((index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // 追加文件
  const handleAddFiles = useCallback((newFiles: PendingFile[]) => {
    setPendingFiles((prev) => [...prev, ...newFiles]);
  }, []);

  // 保存任务
  const handleSaveTask = useCallback(async () => {
    // 使用工具函数转换为保存格式
    const items = pendingFiles.map(pendingFileToSaveFormat);

    if (savedTaskId) {
      // 更新现有任务
      await window.ipc.invoke('updateProofreadTask', {
        taskId: savedTaskId,
        updates: { items, name: taskName },
      });
    } else {
      // 创建新任务
      const result = await window.ipc.invoke('createProofreadTask', {
        items,
        name:
          taskName ||
          pendingFiles[0]?.fileName?.replace(/\.[^.]+$/, '') ||
          'Untitled',
      });
      if (result.success) {
        setSavedTaskId(result.data.id);
      }
    }
    return true;
  }, [pendingFiles, savedTaskId, taskName]);

  // 重置，开始新的导入
  const handleReset = useCallback(() => {
    setPendingFiles([]);
    setCurrentEditIndex(-1);
    setSavedTaskId(null);
    setTaskName('');
    setImportType('video');
    setStage('import');
  }, []);

  // 自动保存：当已保存的任务有变化时自动更新
  const isInitialMount = useRef(true);
  useEffect(() => {
    // 跳过首次加载
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    // 只有在已保存任务且列表不为空时才自动保存
    if (savedTaskId && pendingFiles.length > 0 && stage === 'list') {
      const autoSaveTimeout = setTimeout(async () => {
        try {
          await handleSaveTask();
        } catch (error) {
          console.error('Auto-save failed:', error);
        }
      }, 500); // 防抖 500ms

      return () => clearTimeout(autoSaveTimeout);
    }
  }, [pendingFiles, savedTaskId, stage]);

  // 渲染当前阶段
  const renderStage = () => {
    switch (stage) {
      case 'import':
        return <ProofreadImport onImportComplete={handleImportComplete} />;

      case 'list':
        return (
          <ProofreadFileList
            files={pendingFiles}
            savedTaskId={savedTaskId}
            taskName={taskName}
            importType={importType}
            onTaskNameChange={setTaskName}
            onStartProofread={handleStartProofread}
            onUpdateFile={handleUpdateFile}
            onRemoveFile={handleRemoveFile}
            onAddFiles={handleAddFiles}
            onSaveTask={handleSaveTask}
            onReset={handleReset}
          />
        );

      case 'edit':
        const currentFile = pendingFiles[currentEditIndex];
        return (
          <ProofreadEditor
            file={currentFile}
            onMarkComplete={handleMarkComplete}
            onBack={handleBackToList}
          />
        );

      default:
        return null;
    }
  };

  return (
    <div className="h-full p-4 overflow-hidden flex flex-col">
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'new' | 'history')}
        className="flex-1 flex flex-col min-h-0"
      >
        <TabsList className="grid w-full grid-cols-2 max-w-xs flex-shrink-0">
          <TabsTrigger value="new">
            <Plus className="w-4 h-4 mr-2" />
            {t('newTask') || '新建任务'}
          </TabsTrigger>
          <TabsTrigger value="history">
            <History className="w-4 h-4 mr-2" />
            {t('historyTasks') || '历史任务'}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="new" className="flex-1 overflow-auto mt-4">
          {renderStage()}
        </TabsContent>

        <TabsContent value="history" className="flex-1 overflow-auto mt-4">
          <ProofreadTaskList onLoadTask={handleLoadTask} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export const getStaticProps = makeStaticProperties(['common', 'home']);
export { getStaticPaths };
