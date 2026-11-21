import type { AutomationAction } from './automation-action.value-object.js';
import type { AutomationTrigger } from './automation-trigger.value-object.js';

/** State owned by one organization's Automation rule. */
export interface AutomationRuleState {
  // #region Properties
  /** Stable rule identity. */
  readonly ruleId: string;

  /** Organization that owns the rule. */
  readonly organizationId: string;

  /** Task condition required to consider the action. */
  readonly trigger: AutomationTrigger;

  /** Configured effect to apply through the owning service. */
  readonly action: AutomationAction;

  /** Whether the rule can react to new task facts. */
  readonly enabled: boolean;

  /** Version used by the application when saving changes. */
  readonly version: number;

  /** Time supplied by the caller when it created the rule. */
  readonly createdAt: Date;
  // #endregion
}
