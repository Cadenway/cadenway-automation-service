import type { AutomationTriggerFact } from '../../../../../domain/value-objects/rules/automation-trigger-fact.value-object.js';

/** Verified tenant, source event and candidate rule for an automation decision. */
export interface ExecuteAutomationRuleInput {
  // #region Properties
  /** Organization supplied by the authenticated event context. */
  readonly organizationId: string;

  /** Candidate rule in this organization. */
  readonly ruleId: string;

  /** Source event's stable identity. */
  readonly sourceEventId: string;

  /** Task named by the validated source event. */
  readonly taskKey: string;

  /** Trigger fields from the validated source event. */
  readonly fact: AutomationTriggerFact;

  /** Whether the worker may reserve an action that has no execution identity yet. */
  readonly allowNewReservation: boolean;
  // #endregion
}
