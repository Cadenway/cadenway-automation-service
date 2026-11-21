import type { JobQueueDeclaration } from '@cadenway/nest-jobs/provisioning';

/** Retains abandoned work beyond the action window so a resumed worker can dead-letter it. */
export const AUTOMATION_TASK_TRIGGER_QUEUE = {
  name: 'automation.dispatch-task-trigger',
  retryLimit: 4,
  retryDelaySeconds: 15,
  retryDelayMaxSeconds: 120,
  expireInSeconds: 30,
  retentionSeconds: 48 * 60 * 60,
} as const satisfies JobQueueDeclaration;
