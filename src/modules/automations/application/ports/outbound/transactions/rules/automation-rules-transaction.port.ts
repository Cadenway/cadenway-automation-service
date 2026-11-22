import type { AutomationRule } from '../../../../../domain/aggregates/rules/automation-rule.aggregate.js';
import type { AutomationRuleIdentity } from '../../../../models/rules/automation-rule-identity.model.js';

/** Operations performed in one tenant-scoped rule write transaction. */
export interface AutomationRulesTransaction {
  // #region Properties
  /** Checks the enabled-rule limit under the organization's write lock. */
  readonly hasEnabledRuleCapacity: () => Promise<boolean>;

  /** Allocates the rule identity and its creation timestamp inside this transaction. */
  readonly allocateIdentity: () => Promise<AutomationRuleIdentity>;

  /** Locks and reads the tenant's rule, returning null when it does not exist. */
  readonly find: (ruleId: string) => Promise<AutomationRule | null>;

  /** Inserts a newly created rule in the transaction's tenant. */
  readonly insert: (rule: AutomationRule) => Promise<void>;

  /** Saves the rule only if the previously read version is still current. */
  readonly save: (rule: AutomationRule, expectedVersion: number) => Promise<boolean>;

  /** Removes the rule only if its previously read version remains current. */
  readonly delete: (ruleId: string, expectedVersion: number) => Promise<boolean>;
  // #endregion
}
