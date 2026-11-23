import type { AutomationAction } from '../../../domain/value-objects/rules/automation-action.value-object.js';

type ActionType = AutomationAction['type'];
const alwaysAvailable: readonly ActionType[] = ['assign', 'priority'];
const withComments: readonly ActionType[] = [...alwaysAvailable, 'comment'];
const withCommentAndNotification: readonly ActionType[] = [...withComments, 'notify'];

/** Lists the actions eligible for new decisions in the configured rollout. */
export function availableAutomationActionTypes(
  commentsEnabled: boolean,
  notificationConfigured: boolean,
): readonly ActionType[] {
  if (!commentsEnabled) return alwaysAvailable;
  return notificationConfigured ? withCommentAndNotification : withComments;
}
