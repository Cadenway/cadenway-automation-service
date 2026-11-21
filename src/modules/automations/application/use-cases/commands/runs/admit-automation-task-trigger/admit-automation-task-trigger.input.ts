import type { AutomationTaskTriggerJob } from '../../../../models/runs/automation-task-trigger-job.model.js';

/** Carries the admitted source fact and its JetStream delivery context. */
export interface AdmitAutomationTaskTriggerInput {
  // #region Properties
  /** Organization verified by the JetStream adapter. */
  readonly organizationId: string;

  /** Only the Task fact fields needed to execute a rule. */
  readonly source: AutomationTaskTriggerJob['source'];

  /** Deadline and shutdown signal supplied by the broker runtime. */
  readonly signal: AbortSignal;
  // #endregion
}
