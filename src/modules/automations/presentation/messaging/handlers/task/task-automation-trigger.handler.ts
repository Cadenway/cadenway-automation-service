import {
  eventSchemas,
  TASK_CREATED_V1,
  TASK_STATUS_CHANGED_V1,
  type TaskCreatedV1,
  type TaskStatusChangedV1,
} from '@cadenway/contracts/events/task-service';
import { requireOrganizationId } from '@cadenway/nest-common';
import type { EventConsumers } from '@cadenway/nest-messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';

import type { AdmitAutomationTaskTrigger } from '../../../../application/use-cases/commands/runs/admit-automation-task-trigger/admit-automation-task-trigger.use-case.js';

/** Admits verified Task facts without invoking downstream HTTP in the broker transaction. */
export class TaskAutomationTriggerHandler implements OnApplicationBootstrap {
  // #region Constructor
  /** Binds the kit's subscriber and the tenant-scoped queue. */
  public constructor(
    private readonly consumers: Pick<EventConsumers, 'subscribe'>,
    private readonly command: Pick<AdmitAutomationTaskTrigger, 'execute'>,
  ) {}
  // #endregion

  // #region Methods
  /** Starts new durable consumers at activation; later restarts keep their broker positions. */
  public async onApplicationBootstrap(): Promise<void> {
    await this.consumers.subscribe({
      handler: 'run-task-created-rules',
      schemas: eventSchemas,
      event: TASK_CREATED_V1,
      deliverPolicy: 'new',
      handle: (event, { signal }) => this.admit(event, signal),
    });
    await this.consumers.subscribe({
      handler: 'run-task-status-changed-rules',
      schemas: eventSchemas,
      event: TASK_STATUS_CHANGED_V1,
      deliverPolicy: 'new',
      handle: (event, { signal }) => this.admit(event, signal),
    });
  }

  /** Commits the kit's event-ID receipt and the first page job in the same transaction. */
  private async admit(
    event: TaskCreatedV1 | TaskStatusChangedV1,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const organizationId = requireOrganizationId();
    if (organizationId !== event.organizationId) {
      throw new Error('Automation trigger tenant does not match its verified broker context.');
    }
    const actorType = event.actor.type;
    const trigger =
      'previousStatus' in event
        ? {
            type: 'status' as const,
            previousStatus: event.previousStatus,
            status: event.status,
            actorType,
          }
        : { type: 'created' as const, actorType };
    await this.command.execute({
      organizationId,
      source: {
        id: event.id.toLowerCase(),
        occurredAt: event.occurredAt,
        taskKey: event.key,
        trigger,
      },
      signal,
    });
  }
  // #endregion
}
