import type { AutomationTaskTriggerJob } from '../../../../models/runs/automation-task-trigger-job.model.js';

/** Atomically queues a batch of work for the verified tenant. */
export interface AutomationTriggerJobs {
  // #region Properties
  /** Reuses deterministic occurrence keys for an event's continuation pages and actions. */
  readonly enqueue: (
    organizationId: string,
    jobs: readonly AutomationTaskTriggerJob[],
    signal: AbortSignal,
  ) => Promise<void>;
  // #endregion
}
