import { AutomationRuleError } from '../../errors/rules/automation-rule.error.js';

/** A trigger in the Automations dialog. A status trigger selects the destination status. */
export type AutomationTrigger =
  Readonly<{ type: 'created' }> | Readonly<{ type: 'status'; status: string }>;

/** Creates an immutable trigger and checks status keys against the shared task vocabulary. */
export function makeAutomationTrigger(
  trigger: AutomationTrigger,
  statuses: readonly string[],
): AutomationTrigger {
  switch (trigger.type) {
    case 'created':
      return Object.freeze({ type: 'created' });
    case 'status':
      if (!statuses.includes(trigger.status)) throw new AutomationRuleError('invalid-status');
      return Object.freeze({ type: 'status', status: trigger.status });
    default:
      throw new AutomationRuleError('invalid-trigger');
  }
}
