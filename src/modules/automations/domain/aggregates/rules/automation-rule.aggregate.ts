import { AutomationRuleError } from '../../errors/rules/automation-rule.error.js';
import { makeAutomationAction } from '../../value-objects/rules/automation-action.value-object.js';
import type { AutomationRuleState } from '../../value-objects/rules/automation-rule-state.value-object.js';
import type { AutomationTaskVocabulary } from '../../value-objects/rules/automation-task-vocabulary.value-object.js';
import type { AutomationTriggerFact } from '../../value-objects/rules/automation-trigger-fact.value-object.js';
import { makeAutomationTrigger } from '../../value-objects/rules/automation-trigger.value-object.js';

const ruleId = /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;
const organizationId = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;

/** Owns a workspace rule configured in the Automations dialog. */
export class AutomationRule {
  // #region Constructor
  /** Keeps validated state inside the aggregate. */
  private constructor(private readonly state: AutomationRuleState) {}
  // #endregion

  // #region Methods
  /** Creates an enabled rule at version one, as in the Automations dialog. */
  public static create(
    definition: Omit<AutomationRuleState, 'enabled' | 'version'>,
    vocabulary: AutomationTaskVocabulary,
  ): AutomationRule {
    return AutomationRule.restore({ ...definition, enabled: true, version: 1 }, vocabulary);
  }

  /** Restores stored state after checking rule and operand invariants. */
  public static restore(
    state: AutomationRuleState,
    vocabulary: AutomationTaskVocabulary,
  ): AutomationRule {
    if (!ruleId.test(state.ruleId)) throw new AutomationRuleError('invalid-rule-id');
    if (!organizationId.test(state.organizationId)) {
      throw new AutomationRuleError('invalid-organization-id');
    }
    if (!Number.isFinite(state.createdAt.getTime())) {
      throw new AutomationRuleError('invalid-creation-time');
    }
    if (!Number.isSafeInteger(state.version) || state.version < 1) {
      throw new AutomationRuleError('invalid-version');
    }

    return new AutomationRule({
      ruleId: state.ruleId.toLowerCase(),
      organizationId: state.organizationId.toLowerCase(),
      trigger: makeAutomationTrigger(state.trigger, vocabulary.statuses),
      action: makeAutomationAction(state.action, vocabulary.priorities),
      enabled: state.enabled,
      version: state.version,
      createdAt: new Date(state.createdAt),
    });
  }

  /** Returns the state as a snapshot with a separate timestamp for the caller. */
  public snapshot(): AutomationRuleState {
    return { ...this.state, createdAt: new Date(this.state.createdAt) };
  }

  /** Changes the enabled state. The rule contract preserves the version on a repeated value. */
  public setEnabled(enabled: boolean): AutomationRule {
    if (this.state.enabled === enabled) return this;
    const version = this.state.version + 1;
    if (!Number.isSafeInteger(version)) throw new AutomationRuleError('invalid-version');
    return new AutomationRule({ ...this.state, enabled, version });
  }

  /** Follows the dialog triggers and Decision A's guard against automation feedback loops. */
  public matches(fact: AutomationTriggerFact): boolean {
    if (
      !this.state.enabled ||
      fact.actorType === 'automation' ||
      fact.organizationId.toLowerCase() !== this.state.organizationId
    ) {
      return false;
    }

    const trigger = this.state.trigger;
    if (trigger.type === 'created') return fact.type === 'created';
    return (
      fact.type === 'status' &&
      fact.previousStatus !== fact.status &&
      fact.status === trigger.status
    );
  }
  // #endregion
}
