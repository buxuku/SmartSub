import { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTaskCloudConsent } from './useTaskCloudConsent';
import {
  validateTaskStart,
  type TaskReadinessInput,
  type ValidationReadyResult,
} from '../lib/taskReadiness';
import type {
  TaskSubmission,
  TaskSubmissionResult,
  PendingTaskSubmission,
} from '../../types/taskSubmission';
import { taskSubmissionKey } from '../../types/taskSubmission';

type SubmissionPhase =
  | 'idle'
  | 'validating'
  | 'confirming'
  | 'submitting'
  | 'accepted'
  | 'failed';
type SubmissionInput = Pick<TaskReadinessInput, 'typeDef' | 'translateOn'> &
  Omit<TaskSubmission, 'requestId'>;
type SubmissionOutcome =
  | {
      status: 'accepted';
      snapshot: TaskSubmission['formData'];
      projectId: string;
    }
  | { status: 'invalid'; readiness: ValidationReadyResult }
  | { status: 'cancelled' };

/** Shared start/retry state machine. Only an acknowledged durable submission is accepted. */
export function useTaskSubmission(options?: {
  readPending: () => PendingTaskSubmission | undefined;
  savePending: (pending: PendingTaskSubmission) => void;
}) {
  const [phase, setPhase] = useState<SubmissionPhase>('idle');
  const busy = useRef(false);
  const mounted = useRef(false);
  const pending = useRef<PendingTaskSubmission | null>(null);
  const consent = useTaskCloudConsent();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const transition = (next: SubmissionPhase) => {
    if (mounted.current) setPhase(next);
  };
  const submit = async (input: SubmissionInput): Promise<SubmissionOutcome> => {
    if (busy.current || !mounted.current) return { status: 'cancelled' };
    busy.current = true;
    try {
      const snapshot = structuredClone(input);
      transition('validating');
      let readiness = await validateTaskStart(snapshot);
      if (!mounted.current) return { status: 'cancelled' };
      if (!readiness.valid) {
        transition('failed');
        return { status: 'invalid', readiness };
      }
      transition('confirming');
      if (
        !(await consent.requestConsent(
          readiness.needsTranscription,
          snapshot.formData.transcriptionEngine,
        ))
      ) {
        transition('idle');
        return { status: 'cancelled' };
      }
      transition('validating');
      readiness = await validateTaskStart(snapshot);
      if (!mounted.current) return { status: 'cancelled' };
      if (!readiness.valid) {
        transition('failed');
        return { status: 'invalid', readiness };
      }
      const {
        typeDef: _typeDef,
        translateOn: _translateOn,
        ...payload
      } = snapshot;
      const key = taskSubmissionKey(payload);
      if (!pending.current) pending.current = options?.readPending() || null;
      if (pending.current?.key !== key)
        pending.current = { key, requestId: uuidv4() };
      options?.savePending(pending.current);
      transition('submitting');
      const response: TaskSubmissionResult = await window.ipc.invoke(
        'submitTask',
        {
          ...payload,
          requestId: pending.current.requestId,
        },
      );
      if (
        response?.success !== true ||
        response.projectId !== payload.projectId ||
        response.requestId !== pending.current.requestId ||
        !Array.isArray(response.acceptedFileUuids) ||
        response.acceptedFileUuids.length !== payload.files.length ||
        payload.files.some(
          (file) => !response.acceptedFileUuids.includes(file.uuid),
        )
      )
        throw new Error(
          response?.success === false
            ? response.error
            : 'TASK_SUBMISSION_NOT_ACKNOWLEDGED',
        );
      pending.current = null;
      transition('accepted');
      if (!mounted.current) return { status: 'cancelled' };
      return {
        status: 'accepted',
        snapshot: payload.formData,
        projectId: payload.projectId,
      };
    } catch (error) {
      transition('failed');
      throw error;
    } finally {
      busy.current = false;
    }
  };
  return {
    submit,
    phase,
    starting:
      phase === 'validating' ||
      phase === 'confirming' ||
      phase === 'submitting',
    dialog: consent.dialog,
  };
}
