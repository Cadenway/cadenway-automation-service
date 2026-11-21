import type { AutomationTaskTriggerJob } from '../../../../models/runs/automation-task-trigger-job.model.js';

/** Carries admitted work and its worker-verified tenant. */
export interface DispatchAutomationTaskTriggerInput {
  // #region Properties
  /** Organization from the job envelope. */
  readonly organizationId: string;

  /** The original source fact and this attempt's bounded work. */
  readonly job: AutomationTaskTriggerJob;

  /** Deadline and shutdown signal supplied by the job runtime. */
  readonly signal: AbortSignal;
  // #endregion
}
