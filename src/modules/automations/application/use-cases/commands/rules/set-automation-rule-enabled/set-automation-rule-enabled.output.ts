import type { AutomationRuleState } from '../../../../../domain/value-objects/rules/automation-rule-state.value-object.js';

/** Current rule, absence, or the current version after a precondition failure. */
export type SetAutomationRuleEnabledOutput =
  | Readonly<{ status: 'updated'; rule: AutomationRuleState }>
  | Readonly<{ status: 'not-found' }>
  | Readonly<{ status: 'version-mismatch'; version: number }>;
