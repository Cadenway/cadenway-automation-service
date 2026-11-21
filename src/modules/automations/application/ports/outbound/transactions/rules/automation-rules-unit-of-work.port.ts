import type { AutomationRulesTransaction } from './automation-rules-transaction.port.js';

/** Owns a rule write transaction scoped to the verified organization. */
export interface AutomationRulesUnitOfWork {
  // #region Properties
  /** run for this operation. */
  readonly run: <T>(
    organizationId: string,
    work: (transaction: AutomationRulesTransaction) => Promise<T>,
  ) => Promise<T>;
  // #endregion
}
