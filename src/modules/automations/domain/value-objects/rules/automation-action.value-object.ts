import { AutomationRuleError } from '../../errors/rules/automation-rule.error.js';

const recipientId = /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;
const maxCommentCodePoints = 5_000;

/** One of the four actions offered by the Automations dialog. */
export type AutomationAction =
  | Readonly<{ type: 'assign'; userId: string }>
  | Readonly<{ type: 'priority'; priority: string }>
  | Readonly<{ type: 'notify'; userId: string }>
  | Readonly<{ type: 'comment'; body: string }>;

/** Keeps the action operand and applies the shared Task comment rules to the original Markdown. */
export function makeAutomationAction(
  action: AutomationAction,
  priorities: readonly string[],
): AutomationAction {
  switch (action.type) {
    case 'assign':
    case 'notify':
      if (!recipientId.test(action.userId)) throw new AutomationRuleError('invalid-recipient');
      return Object.freeze({ type: action.type, userId: action.userId.toLowerCase() });
    case 'priority':
      if (!priorities.includes(action.priority)) throw new AutomationRuleError('invalid-priority');
      return Object.freeze({ type: 'priority', priority: action.priority });
    case 'comment':
      if (!/\S/u.test(action.body) || Array.from(action.body).length > maxCommentCodePoints) {
        throw new AutomationRuleError('invalid-comment');
      }
      return Object.freeze({ type: 'comment', body: action.body });
    default:
      throw new AutomationRuleError('invalid-action');
  }
}
