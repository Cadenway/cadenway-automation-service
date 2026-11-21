import {
  eventSchemas,
  TASK_CREATED_V1,
  TASK_STATUS_CHANGED_V1,
} from '@cadenway/contracts/events/task-service';
import { runWithOrganizationContext } from '@cadenway/nest-common';
import type { EventConsumers, EventContext } from '@cadenway/nest-messaging';
import { describe, expect, it, vi } from 'vitest';

import type { AutomationTriggerJobs } from '../../../../application/ports/outbound/jobs/runs/automation-trigger-jobs.port.js';
import { AdmitAutomationTaskTrigger } from '../../../../application/use-cases/commands/runs/admit-automation-task-trigger/admit-automation-task-trigger.use-case.js';
import { TaskAutomationTriggerHandler } from './task-automation-trigger.handler.js';

const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const otherOrganizationId = '01938f6e-0000-7000-8000-000000000002';
const actorId = '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24';
const event = {
  id: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01',
  occurredAt: '2026-11-21T11:00:00.000Z',
  organizationId,
  actor: { type: 'user', id: actorId },
  version: 1,
  key: 'CAD-482',
  spaceId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02',
  listId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03',
  parentKey: null,
  name: 'Refondre l’écran de connexion SSO',
  status: 'progress',
  cancelReason: null,
  priority: 'haute',
  assigneeIds: [],
  dueDate: null,
  startDate: null,
  estimateMinutes: null,
  labels: [],
  completedAt: null,
};

async function setup() {
  const subscribe = vi.fn<EventConsumers['subscribe']>();
  const enqueue = vi.fn<AutomationTriggerJobs['enqueue']>();
  await new TaskAutomationTriggerHandler(
    { subscribe },
    new AdmitAutomationTaskTrigger({ enqueue }),
  ).onApplicationBootstrap();
  const created = subscribe.mock.calls[0]?.[0];
  const changed = subscribe.mock.calls[1]?.[0];
  if (created === undefined || changed === undefined)
    throw new Error('Missing Task subscriptions.');
  const delivery: EventContext = {
    deliveryCount: 1,
    streamSequence: 1,
    redelivered: false,
    claimVersion: vi.fn().mockResolvedValue(true),
    signal: new AbortController().signal,
  };
  return { created, changed, enqueue, delivery };
}

function inTenant<T>(tenant: string, work: () => T): T {
  return runWithOrganizationContext(
    {
      organizationId: tenant,
      actor: { type: 'user', id: actorId },
      role: null,
      scopes: [],
    },
    work,
  );
}

describe('TaskAutomationTriggerHandler', () => {
  it('starts both published event subscriptions at their new durable positions', async () => {
    const { created, changed } = await setup();
    expect(created).toMatchObject({
      handler: 'run-task-created-rules',
      schemas: eventSchemas,
      event: TASK_CREATED_V1,
      deliverPolicy: 'new',
    });
    expect(changed).toMatchObject({
      handler: 'run-task-status-changed-rules',
      schemas: eventSchemas,
      event: TASK_STATUS_CHANGED_V1,
      deliverPolicy: 'new',
    });
  });

  it('admits one page with stable source identity and no extra Task content', async () => {
    const { created, enqueue, delivery } = await setup();
    const data = eventSchemas[TASK_CREATED_V1].parse(event);
    await inTenant(organizationId, () => created.handle(data, delivery));
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      organizationId,
      [
        {
          kind: 'page',
          after: null,
          source: {
            id: event.id,
            occurredAt: event.occurredAt,
            taskKey: event.key,
            trigger: { actorType: 'user', type: 'created' },
          },
        },
      ],
      delivery.signal,
    );
  });

  it('preserves a verified Git transition and ignores automation feedback', async () => {
    const { changed, enqueue, delivery } = await setup();
    const data = eventSchemas[TASK_STATUS_CHANGED_V1].parse({
      ...event,
      previousStatus: 'progress',
      status: 'review',
      cancelNote: null,
      actor: { type: 'git', id: actorId },
      version: 2,
    });
    await inTenant(organizationId, () => changed.handle(data, delivery));
    await inTenant(organizationId, () =>
      changed.handle(
        {
          ...data,
          actor: { type: 'automation', id: actorId },
        },
        delivery,
      ),
    );
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      organizationId,
      [
        {
          kind: 'page',
          after: null,
          source: {
            id: event.id,
            occurredAt: event.occurredAt,
            taskKey: event.key,
            trigger: {
              actorType: 'git',
              type: 'status',
              previousStatus: 'progress',
              status: 'review',
            },
          },
        },
      ],
      delivery.signal,
    );
  });

  it('rejects a tenant mismatch before queuing any job', async () => {
    const { created, enqueue, delivery } = await setup();
    await expect(
      inTenant(otherOrganizationId, () => created.handle(event, delivery)),
    ).rejects.toThrow('verified broker context');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
