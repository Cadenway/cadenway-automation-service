import { AutomationRule } from '../../../../../domain/aggregates/rules/automation-rule.aggregate.js';
import type { AutomationTaskVocabulary } from '../../../../../domain/value-objects/rules/automation-task-vocabulary.value-object.js';
import { isAutomationActionAvailable } from '../../../../models/rules/automation-action-availability.model.js';
import type { AutomationRecipientAuthority } from '../../../../ports/outbound/authorization/rules/automation-recipient-authority.port.js';
import type { AutomationRulesUnitOfWork } from '../../../../ports/outbound/transactions/rules/automation-rules-unit-of-work.port.js';
import type { CreateAutomationRuleInput } from './create-automation-rule.input.js';
import type { CreateAutomationRuleOutput } from './create-automation-rule.output.js';

/** Creates one organization rule after checking recipient eligibility. */
export class CreateAutomationRule {
  // #region Constructor
  /** Binds the write transaction, published task vocabulary and configured action support. */
  public constructor(
    private readonly work: AutomationRulesUnitOfWork,
    private readonly vocabulary: AutomationTaskVocabulary,
    private readonly recipients: AutomationRecipientAuthority,
    private readonly commentAndNotificationEnabled: boolean,
  ) {}
  // #endregion

  // #region Methods
  /** Checks a recipient before storing the rule in the tenant transaction. */
  public async execute(input: CreateAutomationRuleInput): Promise<CreateAutomationRuleOutput> {
    const { action } = input;
    if (
      (action.type === 'assign' || action.type === 'notify') &&
      !(await this.recipients.isActiveRecipient(input.organizationId, action.userId))
    ) {
      return { status: 'recipient-not-active' };
    }
    if (!isAutomationActionAvailable(action.type, this.commentAndNotificationEnabled)) {
      return { status: 'action-unavailable' };
    }
    return this.work.run(input.organizationId, async (transaction) => {
      const identity = await transaction.allocateIdentity();
      const rule = AutomationRule.create({ ...input, ...identity }, this.vocabulary);
      await transaction.insert(rule);
      return { status: 'created', rule: rule.snapshot() };
    });
  }
  // #endregion
}
