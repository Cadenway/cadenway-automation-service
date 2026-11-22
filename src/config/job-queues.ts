import type { JobQueueDeclaration } from '@cadenway/nest-jobs/provisioning';

/** Retains abandoned work beyond the action window so a resumed worker can dead-letter it. */
export const AUTOMATION_TASK_TRIGGER_QUEUE = {
  name: 'automation.dispatch-task-trigger',
  retryLimit: 4,
  retryDelaySeconds: 15,
  retryDelayMaxSeconds: 120,
  expireInSeconds: 30,
  retentionSeconds: 48 * 60 * 60,
  organizationConcurrency: 1,
} as const satisfies JobQueueDeclaration;

/** Deletes expired API receipts in bounded system transactions. */
export const AUTOMATION_PURGE_RECEIPTS_QUEUE = {
  name: 'automation.purge-idempotency-receipts',
  retryLimit: 0,
  expireInSeconds: 30,
} as const satisfies JobQueueDeclaration;

export const jobQueues = [AUTOMATION_TASK_TRIGGER_QUEUE, AUTOMATION_PURGE_RECEIPTS_QUEUE] as const;
