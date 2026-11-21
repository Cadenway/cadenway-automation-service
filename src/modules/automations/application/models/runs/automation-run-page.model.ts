import type { AutomationRun } from './automation-run.model.js';
import type { AutomationRunPosition } from './automation-run-position.model.js';

/** Applied executions and the stable bounds for continuing a history window. */
export interface AutomationRunPage {
  // #region Properties
  /** Applied executions in descending order. */
  readonly items: readonly AutomationRun[];

  /** Inclusive upper bound fixed at the start of the window, if any execution exists. */
  readonly upper: AutomationRunPosition | null;

  /** Cursor position for the last returned execution, if another page exists. */
  readonly next: AutomationRunPosition | null;

  /** Number of candidates remaining within the bounded window. */
  readonly remaining: number;
  // #endregion
}
