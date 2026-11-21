import { isAutomationActionAvailable } from '../../../../models/rules/automation-action-availability.model.js';
import type { AutomationRulesUnitOfWork } from '../../../../ports/outbound/transactions/rules/automation-rules-unit-of-work.port.js';
import type { SetAutomationRuleEnabledInput } from './set-automation-rule-enabled.input.js';
import type { SetAutomationRuleEnabledOutput } from './set-automation-rule-enabled.output.js';

/** Enables or disables one rule in the tenant owning it. */
export class SetAutomationRuleEnabled {
  // #region Constructor
  /** Binds the rule transaction and configured action support. */
  public constructor(
    private readonly work: AutomationRulesUnitOfWork,
    private readonly commentAndNotificationEnabled: boolean,
  ) {}
  // #endregion

  // #region Methods
  /** Checks If-Match before applying the requested state, including for no-op changes. */
  public execute(input: SetAutomationRuleEnabledInput): Promise<SetAutomationRuleEnabledOutput> {
    return this.work.run(input.organizationId, async (transaction) => {
      const rule = await transaction.find(input.ruleId);
      if (rule === null) return { status: 'not-found' };
      const current = rule.snapshot();
      if (input.expectedVersion !== null && input.expectedVersion !== current.version) {
        return { status: 'version-mismatch', version: current.version };
      }
      if (
        input.enabled &&
        !isAutomationActionAvailable(current.action.type, this.commentAndNotificationEnabled)
      ) {
        return { status: 'action-unavailable' };
      }
      const changed = rule.setEnabled(input.enabled);
      if (changed !== rule && !(await transaction.save(changed, current.version))) {
        throw new Error('Locked automation rule changed before it could be saved.');
      }
      return { status: 'updated', rule: changed.snapshot() };
    });
  }
  // #endregion
}
