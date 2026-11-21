import type { AutomationRule } from '../../../domain/aggregates/rules/automation-rule.aggregate.js';
import type { AutomationRulePosition } from './automation-rule-position.model.js';

/** A bounded page and the position of its last item when more rules exist. */
export interface AutomationRulePage {
  // #region Properties
  /** items for this operation. */
  readonly items: readonly AutomationRule[];
  readonly next: AutomationRulePosition | null;
  // #endregion
}
