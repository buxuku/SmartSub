import React, { useMemo, useState } from 'react';
import {
  Filter,
  Merge,
  Palette,
  Trash2,
  UserRoundPlus,
  Users,
} from 'lucide-react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
  SPEAKER_COLOR_PALETTE,
  countSpeakerCues,
  type SpeakerInfo,
} from '../../../types/proofreadData';

export type SpeakerFilter =
  | 'all'
  | 'unassigned'
  | 'overlap'
  | `speaker:${number}`;

interface PendingBulkAction {
  mode: 'move' | 'merge';
  sourceId: number;
  targetId: number;
  count: number;
}

interface SpeakerToolbarProps {
  speakers: SpeakerInfo[];
  subtitles: Subtitle[];
  filter: SpeakerFilter;
  onFilterChange: (filter: SpeakerFilter) => void;
  embedSpeakerNames: boolean;
  onEmbedSpeakerNamesChange: (enabled: boolean) => void;
  onCreateSpeaker: () => number;
  onRenameSpeaker: (speakerId: number, displayName: string) => boolean;
  onSetSpeakerColor: (speakerId: number, color: string) => void;
  onMoveSpeaker: (
    sourceId: number,
    targetId: number,
    removeSource: boolean,
  ) => void;
  onDeleteSpeaker: (speakerId: number) => boolean;
}

export default function SpeakerToolbar({
  speakers,
  subtitles,
  filter,
  onFilterChange,
  embedSpeakerNames,
  onEmbedSpeakerNamesChange,
  onCreateSpeaker,
  onRenameSpeaker,
  onSetSpeakerColor,
  onMoveSpeaker,
  onDeleteSpeaker,
}: SpeakerToolbarProps) {
  const { t } = useTranslation('home');
  const [managerOpen, setManagerOpen] = useState(false);
  const [targetBySpeaker, setTargetBySpeaker] = useState<
    Record<number, number>
  >({});
  const [pendingAction, setPendingAction] = useState<PendingBulkAction | null>(
    null,
  );

  const counts = useMemo(
    () =>
      new Map(
        speakers.map((speaker) => [
          speaker.id,
          countSpeakerCues(subtitles, speaker.id),
        ]),
      ),
    [speakers, subtitles],
  );

  const targetFor = (sourceId: number): number | undefined => {
    const selected = targetBySpeaker[sourceId];
    if (
      selected !== undefined &&
      selected !== sourceId &&
      speakers.some((speaker) => speaker.id === selected)
    ) {
      return selected;
    }
    return speakers.find((speaker) => speaker.id !== sourceId)?.id;
  };

  const requestBulkAction = (
    mode: PendingBulkAction['mode'],
    sourceId: number,
  ) => {
    const targetId = targetFor(sourceId);
    if (!targetId) return;
    setPendingAction({
      mode,
      sourceId,
      targetId,
      count: counts.get(sourceId) || 0,
    });
  };

  const confirmBulkAction = () => {
    if (!pendingAction) return;
    onMoveSpeaker(
      pendingAction.sourceId,
      pendingAction.targetId,
      pendingAction.mode === 'merge',
    );
    setPendingAction(null);
  };

  const speakerName = (id: number): string =>
    speakers.find((speaker) => speaker.id === id)?.displayName || String(id);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-2">
        <Users className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-medium">{t('speakers.label')}</span>
        <Select
          value={filter}
          onValueChange={(value) => onFilterChange(value as SpeakerFilter)}
        >
          <SelectTrigger
            className="h-7 w-44 text-xs"
            aria-label={t('speakers.filter')}
          >
            <Filter className="mr-1 h-3 w-3" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('speakers.filterAll')}</SelectItem>
            {speakers.map((speaker) => (
              <SelectItem key={speaker.id} value={`speaker:${speaker.id}`}>
                {speaker.displayName} ({counts.get(speaker.id) || 0})
              </SelectItem>
            ))}
            <SelectItem value="unassigned">
              {t('speakers.unassigned')}
            </SelectItem>
            <SelectItem value="overlap">{t('speakers.overlap')}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => setManagerOpen(true)}
        >
          <Users className="h-3 w-3" />
          {t('speakers.manage')}
        </Button>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs">
          <Checkbox
            checked={embedSpeakerNames}
            onCheckedChange={(value) =>
              onEmbedSpeakerNamesChange(value === true)
            }
          />
          <span>{t('speakers.embedOnSave')}</span>
        </label>
      </div>

      <Dialog open={managerOpen} onOpenChange={setManagerOpen}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('speakers.manageTitle')}</DialogTitle>
            <DialogDescription>{t('speakers.manageDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {speakers.map((speaker) => {
              const count = counts.get(speaker.id) || 0;
              const targetId = targetFor(speaker.id);
              return (
                <div
                  key={speaker.id}
                  className="space-y-2 rounded-lg border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: speaker.color }}
                    />
                    <Input
                      key={`${speaker.id}:${speaker.displayName}`}
                      defaultValue={speaker.displayName}
                      className="h-8 min-w-40 flex-1"
                      maxLength={40}
                      aria-label={t('speakers.renameFor', {
                        name: speaker.displayName,
                      })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                      onBlur={(event) => {
                        if (!onRenameSpeaker(speaker.id, event.target.value)) {
                          event.target.value = speaker.displayName;
                        }
                      }}
                    />
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {t('speakers.cueCount', { count })}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1 text-xs"
                      onClick={() => {
                        onFilterChange(`speaker:${speaker.id}`);
                        setManagerOpen(false);
                      }}
                    >
                      <Filter className="h-3 w-3" />
                      {t('speakers.locate')}
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Palette className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
                    {SPEAKER_COLOR_PALETTE.map((color, colorIndex) => (
                      <button
                        key={color}
                        type="button"
                        className={`h-5 w-5 rounded-full border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          speaker.color === color
                            ? 'border-foreground'
                            : 'border-transparent'
                        }`}
                        style={{ backgroundColor: color }}
                        title={t('speakers.colorChoice', {
                          number: colorIndex + 1,
                        })}
                        aria-label={t('speakers.colorFor', {
                          name: speaker.displayName,
                          number: colorIndex + 1,
                        })}
                        onClick={() => onSetSpeakerColor(speaker.id, color)}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 border-t pt-2">
                    {speakers.length > 1 && targetId && (
                      <>
                        <Select
                          value={String(targetId)}
                          onValueChange={(value) =>
                            setTargetBySpeaker((current) => ({
                              ...current,
                              [speaker.id]: Number(value),
                            }))
                          }
                        >
                          <SelectTrigger className="h-8 w-44 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {speakers
                              .filter(
                                (candidate) => candidate.id !== speaker.id,
                              )
                              .map((candidate) => (
                                <SelectItem
                                  key={candidate.id}
                                  value={String(candidate.id)}
                                >
                                  {candidate.displayName}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs"
                          disabled={count === 0}
                          onClick={() => requestBulkAction('move', speaker.id)}
                        >
                          {t('speakers.moveAll')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1 text-xs"
                          onClick={() => requestBulkAction('merge', speaker.id)}
                        >
                          <Merge className="h-3 w-3" />
                          {t('speakers.merge')}
                        </Button>
                      </>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-8 gap-1 text-xs text-destructive"
                      disabled={count > 0}
                      title={
                        count > 0 ? t('speakers.deleteNonEmptyHint') : undefined
                      }
                      onClick={() => onDeleteSpeaker(speaker.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                      {t('speakers.deleteEmpty')}
                    </Button>
                  </div>
                </div>
              );
            })}
            <Button
              type="button"
              variant="outline"
              className="w-full gap-1.5"
              onClick={onCreateSpeaker}
            >
              <UserRoundPlus className="h-4 w-4" />
              {t('speakers.newSpeaker')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(pendingAction)}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAction?.mode === 'merge'
                ? t('speakers.mergeConfirmTitle')
                : t('speakers.moveConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction
                ? t(
                    pendingAction.mode === 'merge'
                      ? 'speakers.mergeConfirmDesc'
                      : 'speakers.moveConfirmDesc',
                    {
                      source: speakerName(pendingAction.sourceId),
                      target: speakerName(pendingAction.targetId),
                      count: pendingAction.count,
                    },
                  )
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmBulkAction}>
              {t('confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
