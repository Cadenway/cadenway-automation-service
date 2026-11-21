import type { AutomationAction } from '../../../../../domain/value-objects/rules/automation-action.value-object.js';
import type { AutomationTrigger } from '../../../../../domain/value-objects/rules/automation-trigger.value-object.js';

/** A validated rule definition and trusted tenant. */
export interface CreateAutomationRuleInput {
  // #region Properties
  /** organizationId for this operation. */
  readonly organizationId: string;

  /** UUIDv7 of the authenticated actor who configures the rule. */
  readonly ruleAuthorUserId: string;
  readonly trigger: AutomationTrigger;
  readonly action: AutomationAction;
  // #endregion
}
