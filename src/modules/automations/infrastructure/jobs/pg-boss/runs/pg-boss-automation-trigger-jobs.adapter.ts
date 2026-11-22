import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { JobProducer } from '@cadenway/nest-jobs/runtime';
import { metrics } from '@opentelemetry/api';
import { eq, sql } from 'drizzle-orm';

import { AUTOMATION_TASK_TRIGGER_QUEUE } from '../../../../../../config/job-queues.js';
import type { AutomationTaskTriggerJob } from '../../../../application/models/runs/automation-task-trigger-job.model.js';
import type { AutomationTriggerJobs } from '../../../../application/ports/outbound/jobs/runs/automation-trigger-jobs.port.js';
import { automationTriggerBudget } from '../../../persistence/drizzle/schemas/runs/automation-trigger-budget.schema.js';

const maxEnqueuedJobsPerMinute = 256;
const rejectedJobs = metrics
  .getMeter('automation-service')
  .createCounter('automation.trigger.admission.rejected', {
    description: 'Attempts to enqueue automation jobs outside an organization budget.',
  });

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
  /** Commits the tenant's budget and enqueued work together. */
  public async enqueue(
    organizationId: string,
    jobs: readonly AutomationTaskTriggerJob[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (jobs.length === 0) return;
    if (jobs.length > maxEnqueuedJobsPerMinute)
      throw new RangeError('Automation job batch exceeds its admission budget.');
    await this.runner.run(async (scope) => {
      if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
        throw new Error('Automation trigger organization does not match the tenant transaction.');
      }
      const budget = automationTriggerBudget;
      const windowStart = sql`date_trunc('minute', statement_timestamp())`;
      const admitted = await scope.db
        .insert(budget)
        .values({ organizationId, windowStart, queuedCount: jobs.length })
        .onConflictDoUpdate({
          target: budget.organizationId,
          set: {
            windowStart: sql`excluded.window_start`,
            queuedCount: sql`
              case when ${budget.windowStart} = excluded.window_start
                then ${budget.queuedCount} + excluded.queued_count else excluded.queued_count end
            `,
          },
          setWhere: sql`
            ${budget.windowStart} < excluded.window_start or
            (${budget.windowStart} = excluded.window_start and
              ${budget.queuedCount} + excluded.queued_count <= ${maxEnqueuedJobsPerMinute})
          `,
        })
        .returning({ organizationId: budget.organizationId });

      if (admitted.length === 0) {
        const first = jobs[0];
        const initial = jobs.length === 1 && first?.kind === 'page' && first.after === null;
        rejectedJobs.add(jobs.length, { stage: initial ? 'initial' : 'fanout' });
        if (initial) return;
        throw new Error('The organization has exhausted its automation trigger budget.');
      }
      let duplicates = 0;
      for (const job of jobs) {
        signal.throwIfAborted();
        const occurrenceKey =
          job.kind === 'page'
            ? `page:${job.source.id}:${job.after?.ruleId ?? 'start'}`
            : `action:${job.source.id}:${job.ruleId}`;
        const result = await this.producer.enqueue(scope, AUTOMATION_TASK_TRIGGER_QUEUE.name, job, {
          occurrenceKey,
        });
        if (result.duplicate) duplicates += 1;
      }
      if (duplicates > 0) {
        await scope.db
          .update(budget)
          .set({ queuedCount: sql`${budget.queuedCount} - ${duplicates}` })
          .where(eq(budget.organizationId, organizationId));
      }
      signal.throwIfAborted();
    });
  }
  // #endregion
}
