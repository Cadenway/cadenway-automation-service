import type { AutomationAction } from '../../../domain/value-objects/rules/automation-action.value-object.js';

type ActionType = AutomationAction['type'];
const alwaysAvailable: readonly ActionType[] = ['assign', 'priority'];
const withCommentAndNotification: readonly ActionType[] = [...alwaysAvailable, 'comment', 'notify'];

/** Lists the actions eligible for new decisions in the configured rollout. */
export function availableAutomationActionTypes(
  commentAndNotificationEnabled: boolean,
): readonly ActionType[] {
  return commentAndNotificationEnabled ? withCommentAndNotification : alwaysAvailable;
}

/** Checks whether the configured rollout can admit a new decision for this action. */
export function isAutomationActionAvailable(
  type: ActionType,
  commentAndNotificationEnabled: boolean,
): boolean {
  return availableAutomationActionTypes(commentAndNotificationEnabled).includes(type);
}
