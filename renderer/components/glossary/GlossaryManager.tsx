import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown,
  ArrowUp,
  BookOpenText,
  ChevronLeft,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Info,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Panel, PanelHeader } from '@/components/ui/panel';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn, openUrl } from 'lib/utils';
import { useGlossaries } from 'hooks/useGlossaries';
import type { Glossary, GlossaryEntry } from '../../../types/glossary';
import GlossaryEntryDialog from './GlossaryEntryDialog';

const PROVIDER_GUIDES = [
  { key: 'baidu', url: 'https://fanyi-api.baidu.com/' },
  { key: 'aliyun', url: 'https://mt.console.aliyun.com/' },
  { key: 'volc', url: 'https://console.volcengine.com/translate/home' },
  { key: 'tencent', url: 'https://console.cloud.tencent.com/tmt' },
] as const;

export default function GlossaryManager() {
  const { t } = useTranslation('glossary');
  const {
    glossaries,
    loading,
    create,
    update,
    remove,
    move,
    saveEntry,
    deleteEntry,
    importEntries,
    exportEntries,
  } = useGlossaries();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileShowPanel, setMobileShowPanel] = useState(false);
  const [query, setQuery] = useState('');
  const [glossaryDialogOpen, setGlossaryDialogOpen] = useState(false);
  const [editingGlossary, setEditingGlossary] = useState<Glossary | null>(null);
  const [glossaryName, setGlossaryName] = useState('');
  const [glossaryDescription, setGlossaryDescription] = useState('');
  const [entryDialogOpen, setEntryDialogOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<GlossaryEntry | null>(null);
  const [deleteGlossaryTarget, setDeleteGlossaryTarget] =
    useState<Glossary | null>(null);
  const [deleteEntryTarget, setDeleteEntryTarget] =
    useState<GlossaryEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const selected =
    glossaries.find((glossary) => glossary.id === selectedId) || null;

  useEffect(() => {
    if (selectedId && glossaries.some((item) => item.id === selectedId)) {
      return;
    }
    setSelectedId(glossaries[0]?.id || null);
  }, [glossaries, selectedId]);

  useEffect(() => setQuery(''), [selectedId]);

  const filteredEntries = useMemo(() => {
    if (!selected) return [];
    const normalized = query.trim().toLowerCase();
    if (!normalized) return selected.entries;
    return selected.entries.filter((entry) =>
      [entry.source, entry.target, entry.note || ''].some((value) =>
        value.toLowerCase().includes(normalized),
      ),
    );
  }, [query, selected]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: filteredEntries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    overscan: 10,
  });

  const errorText = (code?: string) =>
    t(`errors.${code || 'generic'}`, {
      defaultValue: t('errors.generic'),
    });

  const openCreateGlossary = () => {
    setEditingGlossary(null);
    setGlossaryName('');
    setGlossaryDescription('');
    setGlossaryDialogOpen(true);
  };

  const openEditGlossary = (glossary: Glossary) => {
    setEditingGlossary(glossary);
    setGlossaryName(glossary.name);
    setGlossaryDescription(glossary.description || '');
    setGlossaryDialogOpen(true);
  };

  const handleSaveGlossary = async () => {
    setSaving(true);
    try {
      const result = editingGlossary
        ? await update(editingGlossary.id, {
            name: glossaryName,
            description: glossaryDescription,
          })
        : await create({
            name: glossaryName,
            description: glossaryDescription,
          });
      if (!result.success) {
        toast.error(errorText(result.error));
        return;
      }
      if (result.data) setSelectedId(result.data.id);
      setGlossaryDialogOpen(false);
      toast.success(
        editingGlossary
          ? t('toasts.glossaryUpdated')
          : t('toasts.glossaryCreated'),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (glossary: Glossary, enabled: boolean) => {
    const result = await update(glossary.id, { enabled });
    if (!result.success) toast.error(errorText(result.error));
  };

  const handleMove = async (glossary: Glossary, direction: -1 | 1) => {
    const result = await move(glossary.id, direction);
    if (!result.success) toast.error(errorText(result.error));
  };

  const handleDeleteGlossary = async () => {
    if (!deleteGlossaryTarget) return;
    const result = await remove(deleteGlossaryTarget.id);
    if (result.success) {
      toast.success(t('toasts.glossaryDeleted'));
      setDeleteGlossaryTarget(null);
      return;
    }
    toast.error(errorText(result.error));
  };

  const openAddEntry = () => {
    setEditingEntry(null);
    setEntryDialogOpen(true);
  };

  const handleSaveEntry = async (value: {
    source: string;
    target: string;
    note: string;
  }) => {
    if (!selected) return;
    setSaving(true);
    try {
      const result = await saveEntry(selected.id, {
        ...(editingEntry ? { id: editingEntry.id } : {}),
        ...value,
      });
      if (!result.success) {
        toast.error(errorText(result.error));
        return;
      }
      setEntryDialogOpen(false);
      toast.success(
        editingEntry ? t('toasts.entryUpdated') : t('toasts.entryCreated'),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteEntry = async () => {
    if (!selected || !deleteEntryTarget) return;
    const result = await deleteEntry(selected.id, deleteEntryTarget.id);
    if (result.success) {
      toast.success(t('toasts.entryDeleted'));
      setDeleteEntryTarget(null);
      return;
    }
    toast.error(errorText(result.error));
  };

  const handleImport = async () => {
    if (!selected) return;
    setBusyAction('import');
    try {
      const result = await importEntries(selected.id);
      if (result.canceled) return;
      if (!result.success || !result.data) {
        toast.error(errorText(result.error));
        return;
      }
      toast.success(
        t('toasts.imported', {
          added: result.data.added,
          updated: result.data.updated,
          skipped: result.data.skipped,
        }),
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleExport = async (format: 'csv' | 'txt') => {
    if (!selected) return;
    setBusyAction(`export-${format}`);
    try {
      const result = await exportEntries(selected.id, format);
      if (result.canceled) return;
      if (!result.success) {
        toast.error(errorText(result.error));
        return;
      }
      toast.success(t('toasts.exported'));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Panel
        className={cn(
          'min-h-0 overflow-hidden',
          mobileShowPanel && 'hidden lg:flex',
        )}
      >
        <PanelHeader
          title={t('list.title')}
          meta={t('list.priorityHint')}
          actions={
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t('actions.addGlossary')}
              onClick={openCreateGlossary}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {loading ? (
            <div className="flex h-24 items-center justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : glossaries.length === 0 ? (
            <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 px-5 text-center">
              <BookOpenText className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">{t('empty.noGlossaries')}</p>
              <p className="text-xs text-muted-foreground">
                {t('empty.noGlossariesHint')}
              </p>
              <Button size="sm" className="mt-2" onClick={openCreateGlossary}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                {t('actions.addGlossary')}
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              {glossaries.map((glossary, index) => (
                <div
                  key={glossary.id}
                  role="button"
                  tabIndex={0}
                  aria-current={selectedId === glossary.id ? 'true' : undefined}
                  onClick={() => {
                    setSelectedId(glossary.id);
                    setMobileShowPanel(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedId(glossary.id);
                      setMobileShowPanel(true);
                    }
                  }}
                  className={cn(
                    'group relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    selectedId === glossary.id
                      ? 'bg-primary/10 text-primary before:absolute before:inset-y-2 before:-left-1.5 before:w-[3px] before:rounded-r-full before:bg-primary'
                      : 'hover:bg-accent',
                  )}
                >
                  <div onClick={(event) => event.stopPropagation()}>
                    <Switch
                      checked={glossary.enabled}
                      aria-label={t('list.toggleAria', { name: glossary.name })}
                      onCheckedChange={(checked) =>
                        void handleToggle(glossary, checked)
                      }
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">
                      {glossary.name}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {t('list.entryCount', { count: glossary.entries.length })}
                    </div>
                  </div>
                  <div
                    className="flex flex-none items-center"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      disabled={index === 0}
                      aria-label={t('actions.moveUp')}
                      onClick={() => void handleMove(glossary, -1)}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      disabled={index === glossaries.length - 1}
                      aria-label={t('actions.moveDown')}
                      onClick={() => void handleMove(glossary, 1)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Panel>

      <Panel
        className={cn(
          'min-h-0 overflow-hidden',
          !mobileShowPanel && 'hidden lg:flex',
        )}
      >
        {!selected ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <BookOpenText className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm font-medium">{t('empty.selectGlossary')}</p>
            <p className="max-w-md text-xs text-muted-foreground">
              {t('empty.selectGlossaryHint')}
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 lg:hidden"
                onClick={() => setMobileShowPanel(false)}
                aria-label={t('actions.backToList')}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-[15px] font-semibold">
                    {selected.name}
                  </h2>
                  <Badge variant={selected.enabled ? 'default' : 'outline'}>
                    {selected.enabled
                      ? t('status.enabled')
                      : t('status.disabled')}
                  </Badge>
                </div>
                {selected.description && (
                  <p className="truncate text-xs text-muted-foreground">
                    {selected.description}
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => openEditGlossary(selected)}
              >
                <Pencil className="h-3.5 w-3.5" />
                {t('actions.editGlossary')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                disabled={busyAction !== null}
                onClick={() => void handleImport()}
              >
                {busyAction === 'import' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {t('actions.import')}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5"
                    disabled={busyAction !== null}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {t('actions.export')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void handleExport('csv')}>
                    <FileSpreadsheet className="mr-2 h-4 w-4" />
                    {t('actions.exportCsv')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleExport('txt')}>
                    <FileText className="mr-2 h-4 w-4" />
                    {t('actions.exportTxt')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive"
                aria-label={t('actions.deleteGlossary')}
                onClick={() => setDeleteGlossaryTarget(selected)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex flex-none flex-col gap-2 border-b p-3">
              <Alert className="border-primary/20 bg-primary/5 py-3">
                <Info className="h-4 w-4" />
                <AlertTitle className="text-sm">
                  {t('aiGuide.title')}
                </AlertTitle>
                <AlertDescription className="text-xs text-muted-foreground">
                  {t('aiGuide.description')}
                </AlertDescription>
              </Alert>
              <Alert className="py-3">
                <Info className="h-4 w-4" />
                <AlertTitle className="text-sm">
                  {t('traditionalGuide.title')}
                </AlertTitle>
                <AlertDescription>
                  <p className="text-xs text-muted-foreground">
                    {t('traditionalGuide.description')}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {PROVIDER_GUIDES.map((guide) => (
                      <Button
                        key={guide.key}
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 text-xs"
                        onClick={() => openUrl(guide.url)}
                      >
                        {t(`traditionalGuide.providers.${guide.key}`)}
                        <ExternalLink className="h-3 w-3" />
                      </Button>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            </div>

            <div className="flex flex-none items-center gap-2 border-b p-2.5">
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('search.placeholder')}
                  className="h-8 pl-8 text-xs"
                />
              </div>
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {query
                  ? t('search.resultCount', { count: filteredEntries.length })
                  : t('list.entryCount', { count: selected.entries.length })}
              </span>
              <Button size="sm" className="h-8 gap-1.5" onClick={openAddEntry}>
                <Plus className="h-3.5 w-3.5" />
                {t('actions.addEntry')}
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {filteredEntries.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <BookOpenText className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium">
                    {query ? t('empty.noSearchResults') : t('empty.noEntries')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {query
                      ? t('empty.noSearchResultsHint')
                      : t('empty.noEntriesHint')}
                  </p>
                </div>
              ) : (
                <div className="flex h-full min-w-0 flex-col">
                  <div
                    role="row"
                    className="grid min-w-[700px] flex-none grid-cols-[minmax(140px,1fr)_minmax(160px,1.2fr)_minmax(120px,0.9fr)_72px] border-b bg-muted/30 px-3 text-xs font-medium text-muted-foreground"
                  >
                    <div className="py-2">{t('fields.source')}</div>
                    <div className="py-2">{t('fields.target')}</div>
                    <div className="py-2">{t('fields.note')}</div>
                    <div className="py-2 text-right">{t('fields.actions')}</div>
                  </div>
                  <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
                    <div
                      className="relative min-w-[700px]"
                      style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                    >
                      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                        const entry = filteredEntries[virtualRow.index];
                        return (
                          <div
                            key={entry.id}
                            role="row"
                            className="absolute left-0 top-0 grid w-full grid-cols-[minmax(140px,1fr)_minmax(160px,1.2fr)_minmax(120px,0.9fr)_72px] items-center border-b px-3 text-sm hover:bg-muted/30"
                            style={{
                              height: `${virtualRow.size}px`,
                              transform: `translateY(${virtualRow.start}px)`,
                            }}
                          >
                            <div
                              className="truncate pr-3 font-medium"
                              title={entry.source}
                            >
                              {entry.source}
                            </div>
                            <div className="truncate pr-3" title={entry.target}>
                              {entry.target}
                            </div>
                            <div
                              className="truncate pr-3 text-xs text-muted-foreground"
                              title={entry.note || ''}
                            >
                              {entry.note || '—'}
                            </div>
                            <div className="flex justify-end gap-0.5">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                aria-label={t('actions.editEntry')}
                                onClick={() => {
                                  setEditingEntry(entry);
                                  setEntryDialogOpen(true);
                                }}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-destructive hover:text-destructive"
                                aria-label={t('actions.deleteEntry')}
                                onClick={() => setDeleteEntryTarget(entry)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </Panel>

      <Dialog open={glossaryDialogOpen} onOpenChange={setGlossaryDialogOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>
              {editingGlossary
                ? t('glossaryDialog.editTitle')
                : t('glossaryDialog.addTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('glossaryDialog.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label htmlFor="glossary-name" className="text-sm font-medium">
                {t('glossaryDialog.name')}
              </label>
              <Input
                id="glossary-name"
                value={glossaryName}
                maxLength={80}
                autoFocus
                onChange={(event) => setGlossaryName(event.target.value)}
                placeholder={t('glossaryDialog.namePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="glossary-description"
                className="text-sm font-medium"
              >
                {t('glossaryDialog.descriptionLabel')}
              </label>
              <Textarea
                id="glossary-description"
                value={glossaryDescription}
                maxLength={500}
                onChange={(event) => setGlossaryDescription(event.target.value)}
                placeholder={t('glossaryDialog.descriptionPlaceholder')}
                className="min-h-[88px] resize-y"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setGlossaryDialogOpen(false)}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              disabled={!glossaryName.trim() || saving}
              onClick={() => void handleSaveGlossary()}
            >
              {saving ? t('actions.saving') : t('actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <GlossaryEntryDialog
        open={entryDialogOpen}
        entry={editingEntry}
        saving={saving}
        onOpenChange={setEntryDialogOpen}
        onSave={(value) => void handleSaveEntry(value)}
      />

      <AlertDialog
        open={deleteGlossaryTarget !== null}
        onOpenChange={(open) => !open && setDeleteGlossaryTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteGlossary.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteGlossary.description', {
                name: deleteGlossaryTarget?.name || '',
                count: deleteGlossaryTarget?.entries.length || 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleDeleteGlossary()}
            >
              {t('actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteEntryTarget !== null}
        onOpenChange={(open) => !open && setDeleteEntryTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteEntry.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteEntry.description', {
                source: deleteEntryTarget?.source || '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleDeleteEntry()}
            >
              {t('actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
