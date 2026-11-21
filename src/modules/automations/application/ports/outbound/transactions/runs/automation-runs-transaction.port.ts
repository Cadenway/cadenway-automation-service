import type { AutomationRule } from '../../../../../domain/aggregates/rules/automation-rule.aggregate.js';
import type { AutomationRun } from '../../../../models/runs/automation-run.model.js';
import type { AutomationRunReservation } from '../../../../models/runs/automation-run-reservation.model.js';

/** Reads and writes one tenant's execution decisions in a single transaction. */
export interface AutomationRunsTransaction {
  // #region Properties
  /** Reads a prior decision without depending on the current rule state. */
  readonly findBySource: (ruleId: string, sourceEventId: string) => Promise<AutomationRun | null>;

  /** Locks a current rule against disablement and deletion before a new decision. */
  readonly lockRule: (ruleId: string) => Promise<AutomationRule | null>;

  /** Reserves once and returns the existing decision when another transaction won the race. */
  readonly reserve: (input: AutomationRunReservation) => Promise<AutomationRun>;

  /** Changes a pending decision once and returns whether this transaction made the transition. */
  readonly settle: (runId: string, disposition: 'applied' | 'no_op') => Promise<boolean>;

  /** Appends the published execution fact through this same transaction's outbox. */
  readonly appendExecuted: (run: AutomationRun) => Promise<void>;
  // #endregion
}
