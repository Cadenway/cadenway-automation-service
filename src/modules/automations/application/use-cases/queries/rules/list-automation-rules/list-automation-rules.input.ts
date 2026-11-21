import type { AutomationRulePosition } from '../../../../models/rules/automation-rule-position.model.js';

/** Decoded, authorized list position and bounded page size. */
export interface ListAutomationRulesInput {
  // #region Properties
  /** organizationId for this operation. */
  readonly organizationId: string;
  readonly after: AutomationRulePosition | null;
  readonly limit: number;
  // #endregion
}
