import { getOrganizationContext } from '@cadenway/nest-common';
import type { Job, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { describe, expect, it, vi } from 'vitest';

import type { DispatchAutomationTaskTrigger } from '../../../../application/use-cases/commands/runs/dispatch-automation-task-trigger/dispatch-automation-task-trigger.use-case.js';
import { AutomationTriggerJobHandler } from './automation-trigger.handler.js';

const queue = 'automation.dispatch-task-trigger';
const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';

function makeJob(occurredAt = new Date()): Job {
  return {
    id: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01',
    organizationId,
    queue,
    attempt: 1,
    signal: new AbortController().signal,
    payload: {
      kind: 'page',
      after: null,
      source: {
        id: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02',
        occurredAt: occurredAt.toISOString(),
        taskKey: 'CAD-482',
        trigger: { actorType: 'user', type: 'created' },
      },
    },
  };
}

function setup() {
  const work = vi.fn<JobWorkerRegistry['work']>();
  const execute = vi.fn<DispatchAutomationTaskTrigger['execute']>();
  return { handler: new AutomationTriggerJobHandler({ work }, { execute }, queue), work, execute };
}

describe('AutomationTriggerJobHandler', () => {
  it('registers a single worker for the configured queue', async () => {
    const { handler, work } = setup();
    await handler.onApplicationBootstrap();
    expect(work).toHaveBeenCalledExactlyOnceWith(queue, expect.any(Function));
  });

  it('passes the validated job and uses its envelope to establish a tenant context', async () => {
    const { handler, execute } = setup();
    const job = makeJob();
    execute.mockImplementation((input) => {
      expect(getOrganizationContext()).toMatchObject({ organizationId, actor: { type: 'system' } });
      expect(input).toEqual({ organizationId, job: job.payload, signal: job.signal });
      return Promise.resolve();
    });
    await handler.handle(job);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('fails closed on malformed, abandoned or expired work before dispatch', async () => {
    const { handler, execute } = setup();
    await expect(handler.handle({ ...makeJob(), organizationId: null })).rejects.toThrow('invalid');
    await expect(handler.handle(makeJob(new Date(Date.now() - 3_600_000)))).rejects.toThrow(
      'outside the action window',
    );
    await expect(handler.handle(makeJob(new Date(Date.now() + 120_000)))).rejects.toThrow(
      'outside the action window',
    );
    await expect(
      handler.handle({
        ...makeJob(),
        signal: AbortSignal.abort(new Error('Cancelled')),
      }),
    ).rejects.toThrow('Cancelled');
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails an interrupted dispatch with a fixed diagnostic for retry and dead letters', async () => {
    const { handler, execute } = setup();
    execute.mockRejectedValue(new Error('Untrusted response detail'));
    await expect(handler.handle(makeJob())).rejects.toThrow(
      /^Automation trigger did not complete\.$/u,
    );
  });
});
