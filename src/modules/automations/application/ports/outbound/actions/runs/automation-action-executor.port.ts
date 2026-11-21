import type { AutomationRun } from '../../../../models/runs/automation-run.model.js';

/** Calls the owner of an action using the stable identity of its reserved execution. */
export interface AutomationActionExecutor {
  // #region Properties
  /** A replay returns the original disposition. Cancellation leaves an uncertain action retryable. */
  readonly execute: (run: AutomationRun, signal?: AbortSignal) => Promise<'applied' | 'no_op'>;
  // #endregion
}
