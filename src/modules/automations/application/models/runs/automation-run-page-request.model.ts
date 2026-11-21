import type { AutomationRunPosition } from './automation-run-position.model.js';

/** Bounded request for one stable window of applied automation executions. */
export interface AutomationRunPageRequest {
  // #region Properties
  /** Inclusive bound fixed by the first page; null starts a new window. */
  readonly upper: AutomationRunPosition | null;

  /** Exclusive position of the preceding page. */
  readonly after: AutomationRunPosition | null;

  /** Maximum number of executions in this page, up to 100. */
  readonly limit: number;

  /** Maximum number of candidates left in the fixed window, up to 100. */
  readonly remaining: number;
  // #endregion
}
