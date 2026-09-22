import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { BookPlus, Loader2, Check, X, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Subtitle } from '../../hooks/useSubtitles';
import {
  planGlossaryReplacement,
  type SubtitleField,
} from '../../lib/contextGlossary';
import { useNavigationGuard } from '@/context/NavigationGuardContext';

interface Selection {
  text: string;
  field: SubtitleField;
  index: number;
  row: string;
  x: number;
  y: number;
}
interface Props {
  children: React.ReactNode;
  documentKey: string;
  projectId?: string;
  ensureProject?: () => Promise<string | undefined>;
  shouldShowTranslation: boolean;
  getSubtitles: () => Subtitle[];
  updateSubtitles: (cues: Subtitle[]) => void;
}

export default function ContextGlossary(props: Props) {
  const { t } = useTranslation('home');
  const latest = useRef(props);
  latest.current = props;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [open, setOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const dirtyRef = useRef(false);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [replaceFrom, setReplaceFrom] = useState('');
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<string>();
  const [plan, setPlan] = useState<ReturnType<
    typeof planGlossaryReplacement
  > | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    generation.current++;
    dirtyRef.current = false;
    setDiscardOpen(false);
    setSelection(null);
    setOpen(false);
    setPlan(null);
    setError('');
    setSaving(false);
    savingRef.current = false;
  }, [props.documentKey]);
  useEffect(() => {
    const dismiss = () => setSelection(null);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, []);
  const close = () => {
    dirtyRef.current = false;
    setOpen(false);
    setSelection(null);
    setPlan(null);
    setDiscardOpen(false);
  };
  const requestClose = () => {
    if (savingRef.current) return;
    if (dirtyRef.current) setDiscardOpen(true);
    else close();
  };
  useNavigationGuard(`context-glossary-${props.documentKey}`, {
    isDirty: open && !saved,
    getIsDirty: () => dirtyRef.current,
    onSave: () => save(),
    onDiscard: () => {
      generation.current++;
      close();
    },
  });

  const capture = (event: React.SyntheticEvent<HTMLDivElement>) => {
    if (open) return;
    const element = event.target;
    if (element instanceof Element && element.closest('[data-glossary-bubble]'))
      return;
    if ('key' in event && event.key === 'Escape') {
      setSelection(null);
      return;
    }
    if (!(element instanceof HTMLTextAreaElement)) {
      setSelection(null);
      return;
    }
    const match = /^subtitle-(src|tgt)-(\d+)$/.exec(element.id);
    const text = element.value
      .slice(element.selectionStart, element.selectionEnd)
      .trim();
    if (!match || !text || text.length > 300) {
      setSelection(null);
      return;
    }
    const index = Number(match[2]);
    const cue = props.getSubtitles()[index];
    if (!cue) return;
    const rect = element.getBoundingClientRect();
    setSelection({
      text,
      index,
      row: JSON.stringify(cue),
      field: match[1] === 'src' ? 'sourceContent' : 'targetContent',
      x: Math.min(Math.max(8, rect.left + 8), window.innerWidth - 200),
      y: Math.max(8, Math.min(rect.top - 34, window.innerHeight - 42)),
    });
  };
  const start = () => {
    if (
      !selection ||
      JSON.stringify(props.getSubtitles()[selection.index]) !== selection.row
    ) {
      setSelection(null);
      return;
    }
    setSource(selection.field === 'sourceContent' ? selection.text : '');
    setTarget(selection.field === 'targetContent' ? selection.text : '');
    dirtyRef.current = true;
    setReplaceFrom(selection.text);
    setScope('project');
    setSaved(false);
    setError('');
    setConflict(undefined);
    setPlan(null);
    setOpen(true);
  };
  const makePlan = () => {
    const field = latest.current.shouldShowTranslation
      ? 'targetContent'
      : 'sourceContent';
    setPlan(
      planGlossaryReplacement(
        latest.current.getSubtitles(),
        field,
        replaceFrom.trim(),
        target.trim(),
      ),
    );
    setError('');
  };
  const save = async (expectedTarget?: string): Promise<boolean> => {
    if (savingRef.current || !source.trim() || !target.trim()) return false;
    savingRef.current = true;
    setSaving(true);
    setError('');
    const currentGeneration = generation.current;
    const context = latest.current;
    try {
      const projectId =
        scope === 'project'
          ? context.projectId || (await context.ensureProject?.())
          : undefined;
      if (!mounted.current || generation.current !== currentGeneration)
        return false;
      if (scope === 'project' && !projectId)
        throw new Error(t('contextGlossary.projectRequired'));
      const result = await window.ipc.invoke('glossaries:add-context-entry', {
        source: source.trim(),
        target: target.trim(),
        scope,
        projectId,
        expectedTarget,
      });
      if (!mounted.current || generation.current !== currentGeneration)
        return false;
      if (
        result?.error === 'ENTRY_CONFLICT' &&
        typeof result.data?.entry?.target === 'string'
      ) {
        setConflict(result.data.entry.target);
        return false;
      }
      if (result?.success !== true || !result.data?.entry?.id)
        throw new Error(result?.error || t('contextGlossary.saveFailed'));
      window.dispatchEvent(new Event('smartsub:glossary-changed'));
      dirtyRef.current = false;
      setSaved(true);
      setConflict(undefined);
      makePlan();
      return true;
    } catch (cause) {
      if (mounted.current && generation.current === currentGeneration)
        setError(String(cause));
      return false;
    } finally {
      if (mounted.current && generation.current === currentGeneration) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };
  const apply = () => {
    if (!plan) return;
    if (JSON.stringify(props.getSubtitles()) !== plan.snapshot) {
      setError(t('contextGlossary.stale'));
      return;
    }
    if (plan.count) props.updateSubtitles(plan.next);
    close();
  };

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-col"
      onMouseUp={capture}
      onKeyUp={capture}
      onScrollCapture={() => !open && setSelection(null)}
    >
      {props.children}
      {selection && !open && (
        <Button
          data-glossary-bubble
          size="sm"
          className="fixed z-40 h-8 gap-1 shadow-md"
          style={{ left: selection.x, top: selection.y }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={start}
        >
          <BookPlus className="h-4 w-4" />
          {t('contextGlossary.add')}
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) requestClose();
        }}
      >
        <DialogContent
          className="max-w-md max-h-[85vh] overflow-y-auto"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>
              {t(
                saved ? 'contextGlossary.replaceTitle' : 'contextGlossary.add',
              )}
            </DialogTitle>
          </DialogHeader>
          {!saved ? (
            <>
              <label className="space-y-1 text-sm">
                {t('sourceText')}
                <Input
                  aria-label={t('sourceText')}
                  value={source}
                  maxLength={300}
                  disabled={saving}
                  onChange={(e) => {
                    setSource(e.target.value);
                    setConflict(undefined);
                  }}
                />
              </label>
              <label className="space-y-1 text-sm">
                {t('contextGlossary.target')}
                <Input
                  aria-label={t('contextGlossary.target')}
                  value={target}
                  maxLength={600}
                  disabled={saving}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    setConflict(undefined);
                  }}
                />
              </label>
              <Select
                value={scope}
                disabled={saving}
                onValueChange={(value: 'project' | 'global') => {
                  setScope(value);
                  setConflict(undefined);
                }}
              >
                <SelectTrigger aria-label={t('contextGlossary.scope')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="project">
                    {t('contextGlossary.project')}
                  </SelectItem>
                  <SelectItem value="global">
                    {t('contextGlossary.global')}
                  </SelectItem>
                </SelectContent>
              </Select>
              {conflict !== undefined && (
                <p role="alert" className="text-sm text-amber-600 break-words">
                  {t('contextGlossary.conflict', { target: conflict })}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-sm">{t('contextGlossary.saved')}</p>
              <label className="space-y-1 text-sm">
                {t(
                  props.shouldShowTranslation
                    ? 'contextGlossary.findTarget'
                    : 'contextGlossary.findSource',
                )}
                <Input
                  aria-label={t(
                    props.shouldShowTranslation
                      ? 'contextGlossary.findTarget'
                      : 'contextGlossary.findSource',
                  )}
                  value={replaceFrom}
                  onChange={(event) => {
                    setReplaceFrom(event.target.value);
                    setPlan(null);
                  }}
                />
              </label>
              <p className="text-sm break-words">
                {t('contextGlossary.replaceWith', { target })}
              </p>
              {plan && (
                <>
                  <p role="status" className="text-sm">
                    {t('contextGlossary.matches', { count: plan.count })}
                  </p>
                  <div className="max-h-36 overflow-auto space-y-2 text-xs">
                    {plan.changes.slice(0, 3).map((change) => (
                      <div
                        key={change.index}
                        className="bg-muted/40 p-2 break-words"
                      >
                        <span className="text-muted-foreground">
                          #{change.index + 1}{' '}
                        </span>
                        <del>{change.before}</del>
                        <p className="text-emerald-700 dark:text-emerald-300">
                          {change.after}
                        </p>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          {error && (
            <div role="alert" className="text-sm text-destructive">
              <details open>
                <summary>{t('contextGlossary.saveFailed')}</summary>
                <p className="break-words">{error}</p>
              </details>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={requestClose}
              className="gap-1"
            >
              <X className="h-4 w-4" />
              {t(saved ? 'contextGlossary.keepText' : 'cancel')}
            </Button>
            {saved ? (
              <>
                <Button variant="outline" onClick={makePlan} className="gap-1">
                  <RotateCcw className="h-4 w-4" />
                  {t('contextGlossary.count')}
                </Button>
                <Button
                  disabled={!plan?.count || !!error}
                  onClick={apply}
                  className="gap-1"
                >
                  <Check className="h-4 w-4" />
                  {t('contextGlossary.replaceAll')}
                </Button>
              </>
            ) : (
              <Button
                disabled={saving || !source.trim() || !target.trim()}
                onClick={() => void save(conflict)}
                className="gap-1"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <BookPlus className="h-4 w-4" />
                )}
                {t(
                  conflict !== undefined
                    ? 'contextGlossary.overwrite'
                    : 'contextGlossary.save',
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('contextGlossary.discardTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('contextGlossary.discardDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('contextGlossary.keepEditing')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={close}>
              {t('contextGlossary.discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
