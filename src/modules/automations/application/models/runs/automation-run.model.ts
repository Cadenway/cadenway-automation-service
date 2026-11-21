import type { AutomationAction } from '../../../domain/value-objects/rules/automation-action.value-object.js';

/** An immutable action decision and its durable execution state. */
export interface AutomationRun {
  // #region Properties
  /** Tenant owning the execution. */
  readonly organizationId: string;

  /** Stable identity used as the downstream idempotency key. */
  readonly id: string;

  /** Rule which made the decision. */
  readonly ruleId: string;

  /** Identity of the authenticated source fact. */
  readonly sourceEventId: string;

  /** Task targeted by the source fact. */
  readonly taskKey: string;

  /** Author whose current authority must be checked by the target service. */
  readonly ruleAuthorUserId: string;

  /** Action captured at reservation time. */
  readonly action: AutomationAction;

  /** Durable outcome of the action. */
  readonly status: 'pending' | 'applied' | 'no_op';

  /** Reservation time. */
  readonly createdAt: Date;

  /** Most recent transition time. */
  readonly updatedAt: Date;

  /** Time of successful application, if any. */
  readonly executedAt: Date | null;
  // #endregion
}
