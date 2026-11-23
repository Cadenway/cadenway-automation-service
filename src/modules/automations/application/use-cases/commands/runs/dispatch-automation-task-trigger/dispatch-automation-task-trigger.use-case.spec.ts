import { describe, expect, it, vi } from 'vitest';

import { AutomationRule } from '../../../../../domain/aggregates/rules/automation-rule.aggregate.js';
import { availableAutomationActionTypes } from '../../../../models/rules/automation-action-availability.model.js';
import type { AutomationTaskTriggerJob } from '../../../../models/runs/automation-task-trigger-job.model.js';
import type { AutomationTriggerJobs } from '../../../../ports/outbound/jobs/runs/automation-trigger-jobs.port.js';
import type { AutomationTriggerRulesReader } from '../../../../ports/outbound/persistence/rules/automation-trigger-rules-reader.port.js';
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

function rule(last: string): AutomationRule {
  return AutomationRule.create(
    {
      organizationId,
      ruleId: `019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e${last}`,
      ruleAuthorUserId: authoredBy,
      createdAt: new Date('2026-11-21T10:00:00.000Z'),
      trigger: { type: 'status', status: 'review' },
      action: { type: 'priority', priority: 'haute' },
    },
    { statuses: ['review'], priorities: ['haute'] },
  );
}

function setup(commentsEnabled = false, notificationConfigured = false, admissionEnabled = true) {
  const list = vi.fn<AutomationTriggerRulesReader['listTriggerCandidates']>();
  const enqueue = vi.fn<AutomationTriggerJobs['enqueue']>();
  const action = vi.fn<ExecuteAutomationRule['execute']>().mockResolvedValue({ status: 'ignored' });
  const dispatch = new DispatchAutomationTaskTrigger(
    { listTriggerCandidates: list },
    { enqueue },
    { execute: action },
    availableAutomationActionTypes(commentsEnabled, notificationConfigured),
    admissionEnabled,
  );
  return { list, enqueue, action, dispatch, signal: new AbortController().signal };
}

describe('DispatchAutomationTaskTrigger', () => {
  it('queues one bounded set of actions and still accepts an already scheduled continuation', async () => {
    const { dispatch, list, enqueue, action, signal } = setup();
    const match = rule('10');
    const lastMatch = rule('11');
    const secondPageMatch = rule('12');
    const last = lastMatch.snapshot();
    list
      .mockResolvedValueOnce({
        items: [match, lastMatch],
        next: { createdAt: last.createdAt, ruleId: last.ruleId },
      })
      .mockResolvedValueOnce({ items: [secondPageMatch], next: null });
    const next = {
      kind: 'page',
      source,
      after: { createdAt: last.createdAt.toISOString(), ruleId: last.ruleId },
    } as const;

    await dispatch.execute({ organizationId, signal, job: { kind: 'page', source, after: null } });
    const query = {
      after: null,
      limit: 100,
      occurredAt: new Date(source.occurredAt),
      trigger: { type: 'status', status: 'review' },
      availableActions: ['assign', 'priority'],
    };
    expect(list).toHaveBeenNthCalledWith(1, organizationId, query);
    expect(enqueue).toHaveBeenNthCalledWith(
      1,
      organizationId,
      [
        { kind: 'action', source, ruleId: match.snapshot().ruleId },
        { kind: 'action', source, ruleId: last.ruleId },
      ],
      signal,
    );
    await dispatch.execute({ organizationId, signal, job: next });
    expect(list).toHaveBeenNthCalledWith(2, organizationId, {
      ...query,
      after: { createdAt: last.createdAt, ruleId: last.ruleId },
    });
    expect(enqueue).toHaveBeenNthCalledWith(
      2,
      organizationId,
      [{ kind: 'action', source, ruleId: secondPageMatch.snapshot().ruleId }],
      signal,
    );
    expect(action).not.toHaveBeenCalled();
  });

  it('queries all supported actions after rollout and enqueues nothing for an empty page', async () => {
    const { dispatch, list, enqueue, signal } = setup(true, true);
    const created = { ...source, trigger: { type: 'created', actorType: 'user' } } as const;
    list.mockResolvedValue({ items: [], next: null });

    await dispatch.execute({
      organizationId,
      signal,
      job: { kind: 'page', source: created, after: null },
    });

    expect(list).toHaveBeenCalledExactlyOnceWith(organizationId, {
      after: null,
      limit: 100,
      occurredAt: new Date(source.occurredAt),
      trigger: { type: 'created' },
      availableActions: ['assign', 'priority', 'comment', 'notify'],
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queries Task comments even when the Notification transport is absent', async () => {
    const { dispatch, list, signal } = setup(true);
    list.mockResolvedValue({ items: [], next: null });

    await dispatch.execute({ organizationId, signal, job: { kind: 'page', source, after: null } });

    expect(list).toHaveBeenCalledWith(
      organizationId,
      expect.objectContaining({ availableActions: ['assign', 'priority', 'comment'] }),
    );
  });

  it('skips fanout and only resumes existing reservations when admission is paused', async () => {
    const { dispatch, list, enqueue, action, signal } = setup(true, true, false);
    const { ruleId } = rule('10').snapshot();

    await dispatch.execute({ organizationId, signal, job: { kind: 'page', source, after: null } });
    await dispatch.execute({ organizationId, signal, job: { kind: 'action', source, ruleId } });

    expect(list).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ruleId, sourceEventId: source.id, allowNewReservation: false }),
      signal,
    );
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
        allowNewReservation: true,
        fact: { organizationId, ...source.trigger },
      },
      signal,
    );
    expect(list).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does no work for automation actors, unchanged statuses, or aborted deliveries', async () => {
    const { dispatch, list, enqueue, action, signal } = setup();
    const loop = { ...source, trigger: { ...source.trigger, actorType: 'automation' as const } };
    await dispatch.execute({
      organizationId,
      signal,
      job: { kind: 'page', source: loop, after: null },
    });
    const unchanged = {
      ...source,
      trigger: { ...source.trigger, previousStatus: source.trigger.status },
    };
    await dispatch.execute({
      organizationId,
      signal,
      job: { kind: 'page', source: unchanged, after: null },
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
