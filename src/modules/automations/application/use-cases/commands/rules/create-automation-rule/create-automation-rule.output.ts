import type { AutomationRuleState } from '../../../../../domain/value-objects/rules/automation-rule-state.value-object.js';

/** Created rule or refusal when the recipient is ineligible or the action is unavailable. */
export type CreateAutomationRuleOutput =
  | Readonly<{ status: 'created'; rule: AutomationRuleState }>
  | Readonly<{ status: 'recipient-not-active' }>
  | Readonly<{ status: 'action-unavailable' }>
  | Readonly<{ status: 'enabled-capacity-exhausted' }>;
