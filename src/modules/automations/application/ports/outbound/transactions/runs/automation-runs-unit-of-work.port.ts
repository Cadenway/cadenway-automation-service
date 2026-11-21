import type { AutomationRunsTransaction } from './automation-runs-transaction.port.js';

/** Opens transactions scoped to the verified tenant of an automation execution. */
export interface AutomationRunsUnitOfWork {
  // #region Properties
  /** Runs all reads and writes in the callback atomically for the organization. */
  readonly run: <T>(
    organizationId: string,
    work: (transaction: AutomationRunsTransaction) => Promise<T>,
  ) => Promise<T>;
  // #endregion
}
