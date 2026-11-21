import { describe, expect, it, vi } from 'vitest';

import { AutomationRule } from '../../../../../domain/aggregates/rules/automation-rule.aggregate.js';
import type { AutomationTaskTriggerJob } from '../../../../models/runs/automation-task-trigger-job.model.js';
import type { AutomationTriggerJobs } from '../../../../ports/outbound/jobs/runs/automation-trigger-jobs.port.js';
import type { AutomationRulesReader } from '../../../../ports/outbound/persistence/rules/automation-rules-reader.port.js';
import type { ExecuteAutomationRule } from '../execute-automation-rule/execute-automation-rule.use-case.js';
import { DispatchAutomationTaskTrigger } from './dispatch-automation-task-trigger.use-case.js';

const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const authoredBy = '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24';
const source = {
  id: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01',
  occurredAt: '2026-11-21T11:00:00.000Z',
  taskKey: 'CAD-482',
  trigger: { type: 'status', previousStatus: 'progress', status: 'review', actorType: 'git' },
} as const satisfies AutomationTaskTriggerJob['source'];

function rule(last: string, createdAt = '2026-11-21T10:00:00.000Z'): AutomationRule {
  return AutomationRule.create(
    {
      organizationId,
      ruleId: `019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e${last}`,
      ruleAuthorUserId: authoredBy,
      createdAt: new Date(createdAt),
      trigger: { type: 'status', status: 'review' },
      action: { type: 'priority', priority: 'haute' },
    },
    { statuses: ['review'], priorities: ['haute'] },
  );
}

function setup() {
  const list = vi.fn<AutomationRulesReader['list']>();
  const enqueue = vi.fn<AutomationTriggerJobs['enqueue']>();
  const action = vi.fn<ExecuteAutomationRule['execute']>().mockResolvedValue({ status: 'ignored' });
  const dispatch = new DispatchAutomationTaskTrigger({ list }, { enqueue }, { execute: action });
  return { list, enqueue, action, dispatch, signal: new AbortController().signal };
}

describe('DispatchAutomationTaskTrigger', () => {
  it('queues eligible actions and the next page atomically without a global rule cap', async () => {
    const { dispatch, list, enqueue, action, signal } = setup();
    const match = rule('10');
    const disabled = rule('11').setEnabled(false);
    const secondPageMatch = rule('12');
    const last = disabled.snapshot();
    list
      .mockResolvedValueOnce({
        items: [match, disabled],
        next: { createdAt: last.createdAt, ruleId: last.ruleId },
      })
      .mockResolvedValueOnce({ items: [secondPageMatch], next: null });
    const next = {
      kind: 'page',
      source,
      after: { createdAt: last.createdAt.toISOString(), ruleId: last.ruleId },
    } as const;

    await dispatch.execute({ organizationId, signal, job: { kind: 'page', source, after: null } });
    expect(list).toHaveBeenNthCalledWith(1, organizationId, { after: null, limit: 32 });
    expect(enqueue).toHaveBeenNthCalledWith(
      1,
      organizationId,
      [{ kind: 'action', source, ruleId: match.snapshot().ruleId }, next],
      signal,
    );
    await dispatch.execute({ organizationId, signal, job: next });
    expect(list).toHaveBeenNthCalledWith(2, organizationId, {
      after: { createdAt: last.createdAt, ruleId: last.ruleId },
      limit: 32,
    });
    expect(enqueue).toHaveBeenNthCalledWith(
      2,
      organizationId,
      [{ kind: 'action', source, ruleId: secondPageMatch.snapshot().ruleId }],
      signal,
    );
    expect(action).not.toHaveBeenCalled();
  });

  it('stops at rules created after the source fact', async () => {
    const { dispatch, list, enqueue, signal } = setup();
    const late = rule('10', '2026-11-21T11:00:00.001Z');
    const { createdAt, ruleId } = late.snapshot();
    list.mockResolvedValue({ items: [late], next: { createdAt, ruleId } });
    await dispatch.execute({ organizationId, signal, job: { kind: 'page', source, after: null } });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('forwards the original fact and source ID unchanged to the command for one action', async () => {
    const { dispatch, list, enqueue, action, signal } = setup();
    const { ruleId } = rule('10').snapshot();
    await dispatch.execute({ organizationId, signal, job: { kind: 'action', source, ruleId } });
    expect(action).toHaveBeenCalledExactlyOnceWith(
      {
        organizationId,
        ruleId,
        sourceEventId: source.id,
        taskKey: source.taskKey,
        fact: { organizationId, ...source.trigger },
      },
      signal,
    );
    expect(list).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does no work for automation actors or aborted deliveries', async () => {
    const { dispatch, list, enqueue, action, signal } = setup();
    const loop = { ...source, trigger: { ...source.trigger, actorType: 'automation' as const } };
    await dispatch.execute({
      organizationId,
      signal,
      job: { kind: 'page', source: loop, after: null },
    });
    await expect(
      dispatch.execute({
        organizationId,
        signal: AbortSignal.abort(new Error('Cancelled attempt')),
        job: { kind: 'page', source, after: null },
      }),
    ).rejects.toThrow('Cancelled attempt');
    expect(list).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });
});
