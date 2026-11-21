import type { AutomationRulePage } from '../../../../models/rules/automation-rule-page.model.js';
import type { AutomationRulePosition } from '../../../../models/rules/automation-rule-position.model.js';

/** Reads one tenant's rules ordered by creation time and rule ID. */
export interface AutomationRulesReader {
  // #region Properties
  /** list for this operation. */
  readonly list: (
    organizationId: string,
    query: { readonly after: AutomationRulePosition | null; readonly limit: number },
  ) => Promise<AutomationRulePage>;
  // #endregion
}
