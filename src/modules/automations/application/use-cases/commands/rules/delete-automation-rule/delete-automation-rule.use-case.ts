import type { AutomationRulesUnitOfWork } from '../../../../ports/outbound/transactions/rules/automation-rules-unit-of-work.port.js';
import type { DeleteAutomationRuleInput } from './delete-automation-rule.input.js';
import type { DeleteAutomationRuleOutput } from './delete-automation-rule.output.js';

/** Removes a rule from management and future trigger decisions. */
export class DeleteAutomationRule {
  // #region Constructor
  /** Binds the unit of work that locks the selected rule. */
  public constructor(private readonly work: AutomationRulesUnitOfWork) {}
  // #endregion

  // #region Methods
  /** Checks the optional version and deletes the selected tenant's rule atomically. */
  public execute(input: DeleteAutomationRuleInput): Promise<DeleteAutomationRuleOutput> {
    return this.work.run(input.organizationId, async (transaction) => {
      const rule = await transaction.find(input.ruleId);
      if (rule === null) return { status: 'not-found' };
      const { version } = rule.snapshot();
      if (input.expectedVersion !== null && input.expectedVersion !== version) {
        return { status: 'version-mismatch', version };
      }
      if (!(await transaction.delete(input.ruleId, version))) {
        throw new Error('Locked automation rule changed before it could be deleted.');
      }
      return { status: 'deleted' };
    });
  }
  // #endregion
}
