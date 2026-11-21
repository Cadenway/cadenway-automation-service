import {
  taskCreatedV1Schema,
  taskStatusChangedV1Schema,
} from '@cadenway/contracts/events/task-service';
import { ProblemException, runWithOrganizationContext } from '@cadenway/nest-common';
import type { Job, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';

import type { DispatchAutomationTaskTrigger } from '../../../../application/use-cases/commands/runs/dispatch-automation-task-trigger/dispatch-automation-task-trigger.use-case.js';

const task = taskCreatedV1Schema.shape;
const actorType = task.actor.shape.type;
const source = z.strictObject({
  id: task.id,
  occurredAt: task.occurredAt,
  taskKey: task.key,
  trigger: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('created'), actorType }),
    z.strictObject({
      type: z.literal('status'),
      actorType,
      previousStatus: taskStatusChangedV1Schema.shape.previousStatus,
      status: taskStatusChangedV1Schema.shape.status,
    }),
  ]),
});
const triggerJob = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('page'),
    source,
    after: z.strictObject({ createdAt: z.iso.datetime(), ruleId: z.uuidv7() }).nullable(),
  }),
  z.strictObject({ kind: z.literal('action'), source, ruleId: z.uuidv7() }),
]);
const clockSkewMs = 60 * 1_000;
const triggerWindowMs = 60 * 60 * 1_000;

/** Executes an admitted page or action outside the broker's deduplication transaction. */
export class AutomationTriggerJobHandler implements OnApplicationBootstrap {
  // #region Constructor
  /** Binds the configured queue to the dispatch command. */
  public constructor(
    private readonly workers: Pick<JobWorkerRegistry, 'work'>,
    private readonly dispatch: Pick<DispatchAutomationTaskTrigger, 'execute'>,
    private readonly queue: string,
  ) {}
  // #endregion

  // #region Methods
  /** Starts the worker on this replica after the queue runtime has been registered. */
  public async onApplicationBootstrap(): Promise<void> {
    await this.workers.work(this.queue, (job) => this.handle(job));
  }

  /** Checks persisted work and uses the organization in the kit's trusted job envelope. */
  public async handle(job: Job): Promise<void> {
    job.signal.throwIfAborted();
    const organization = task.organizationId.safeParse(job.organizationId);
    const payload = triggerJob.safeParse(job.payload);
    if (!organization.success || !payload.success) {
      throw new Error('Automation trigger job is invalid.');
    }
    const age = Date.now() - Date.parse(payload.data.source.occurredAt);
    if (age >= triggerWindowMs || age < -clockSkewMs) {
      throw new Error('Automation trigger job is outside the action window.');
    }
    let failure: string;
    try {
      await runWithOrganizationContext(
        {
          organizationId: organization.data,
          actor: { type: 'system', id: 'automation-service' },
          role: null,
          scopes: [],
        },
        () =>
          this.dispatch.execute({
            job: payload.data,
            organizationId: organization.data,
            signal: job.signal,
          }),
      );
      return;
    } catch (error) {
      // The runtime logs and stores failures. Do not expose downstream details or payloads.
      failure =
        error instanceof ProblemException
          ? `Automation trigger did not complete (status ${String(error.getStatus())}).`
          : 'Automation trigger did not complete.';
    }
    throw new Error(failure);
  }
  // #endregion
}
