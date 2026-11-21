import type { AutomationRuleState } from '../../../../../domain/value-objects/rules/automation-rule-state.value-object.js';

/** Created rule or refusal for a recipient whose eligibility was not confirmed. */
export type CreateAutomationRuleOutput =
  | Readonly<{ status: 'created'; rule: AutomationRuleState }>
  | Readonly<{ status: 'recipient-not-active' }>;
