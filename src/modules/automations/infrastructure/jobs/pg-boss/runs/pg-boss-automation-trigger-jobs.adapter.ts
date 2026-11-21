import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { JobProducer } from '@cadenway/nest-jobs/runtime';

import { AUTOMATION_TASK_TRIGGER_QUEUE } from '../../../../../../config/job-queues.js';
import type { AutomationTaskTriggerJob } from '../../../../application/models/runs/automation-task-trigger-job.model.js';
import type { AutomationTriggerJobs } from '../../../../application/ports/outbound/jobs/runs/automation-trigger-jobs.port.js';

/** Writes trigger work in the caller's tenant-scoped PostgreSQL transaction. */
export class PgBossAutomationTriggerJobs implements AutomationTriggerJobs {
  // #region Constructor
  /** Binds the kit's transaction runner and queue producer. */
  public constructor(
    private readonly runner: TenantTransactionRunner<DatabaseSchema>,
    private readonly producer: JobProducer,
  ) {}
  // #endregion

  // #region Methods
  /** Commits all actions for a page with its continuation, or rolls the whole batch back. */
  public async enqueue(
    organizationId: string,
    jobs: readonly AutomationTaskTriggerJob[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.runner.run(async (scope) => {
      if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
        throw new Error('Automation trigger organization does not match the tenant transaction.');
      }
      for (const job of jobs) {
        signal.throwIfAborted();
        const occurrenceKey =
          job.kind === 'page'
            ? `page:${job.source.id}:${job.after?.ruleId ?? 'start'}`
            : `action:${job.source.id}:${job.ruleId}`;
        await this.producer.enqueue(scope, AUTOMATION_TASK_TRIGGER_QUEUE.name, job, {
          occurrenceKey,
        });
      }
      signal.throwIfAborted();
    });
  }
  // #endregion
}
