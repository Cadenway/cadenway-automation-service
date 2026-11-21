import type { AutomationAction } from '../../../domain/value-objects/rules/automation-action.value-object.js';

/** Immutable information needed to reserve an action for one task fact. */
export interface AutomationRunReservation {
  // #region Properties
  /** Matching rule identity. */
  readonly ruleId: string;

  /** Authenticated source event identity. */
  readonly sourceEventId: string;

  /** Task targeted by the fact. */
  readonly taskKey: string;

  /** Rule author's account, checked again by the owner of the action. */
  readonly ruleAuthorUserId: string;

  /** Rule action as it stood when reserved. */
  readonly action: AutomationAction;
  // #endregion
}
