import type { AutomationRuleState } from '../../../../../domain/value-objects/rules/automation-rule-state.value-object.js';

/** Current rule or refusal when the rule is absent, stale or unavailable for activation. */
export type SetAutomationRuleEnabledOutput =
  | Readonly<{ status: 'updated'; rule: AutomationRuleState }>
  | Readonly<{ status: 'not-found' }>
  | Readonly<{ status: 'version-mismatch'; version: number }>
  | Readonly<{ status: 'action-unavailable' }>;
