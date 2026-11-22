import { describe, expect, it, vi } from 'vitest';

import { AutomationRule } from '../../../../../domain/aggregates/rules/automation-rule.aggregate.js';
import type { AutomationRun } from '../../../../models/runs/automation-run.model.js';
import type { AutomationActionExecutor } from '../../../../ports/outbound/actions/runs/automation-action-executor.port.js';
import type { AutomationRunsTransaction } from '../../../../ports/outbound/transactions/runs/automation-runs-transaction.port.js';
import type { AutomationRunsUnitOfWork } from '../../../../ports/outbound/transactions/runs/automation-runs-unit-of-work.port.js';
import { ExecuteAutomationRule } from './execute-automation-rule.use-case.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b31';
const ruleId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const authorId = '019a5f3c-a0b1-7c2d-9e3f-5a6b7c8d9e32';
const sourceEventId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02';
const runId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03';
const time = new Date('2026-11-20T08:05:00Z');
const action = { type: 'assign', userId: authorId } as const;
const input = {
  organizationId,
  ruleId,
  sourceEventId,
  taskKey: 'CAD-482',
  fact: { organizationId, actorType: 'user', type: 'created' } as const,
};
const pending: AutomationRun = {
  organizationId,
  id: runId,
  ruleId,
  sourceEventId,
  taskKey: input.taskKey,
  ruleAuthorUserId: authorId,
  action,
  status: 'pending',
  createdAt: time,
  updatedAt: time,
  executedAt: null,
};
const rule = AutomationRule.create(
  {
    organizationId,
    ruleId,
    ruleAuthorUserId: authorId,
    createdAt: time,
    trigger: { type: 'created' },
    action,
  },
  { statuses: ['todo'], priorities: ['high'] },
);

function setup(): {
  readonly transaction: AutomationRunsTransaction;
  readonly work: AutomationRunsUnitOfWork;
  readonly actions: AutomationActionExecutor;
} {
  const transaction: AutomationRunsTransaction = {
    findBySource: vi.fn().mockResolvedValue(null),
    lockRule: vi.fn().mockResolvedValue(rule),
    reserve: vi.fn().mockResolvedValue(pending),
    settle: vi.fn().mockResolvedValue(true),
    appendExecuted: vi.fn().mockResolvedValue(undefined),
  };
  const work: AutomationRunsUnitOfWork = {
    run: async <T>(tenant: string, callback: (tx: AutomationRunsTransaction) => Promise<T>) => {
      expect(tenant).toBe(organizationId);
      return callback(transaction);
    },
  };
  const actions: AutomationActionExecutor = { execute: vi.fn().mockResolvedValue('applied') };
  return { transaction, work, actions };
}

describe('ExecuteAutomationRule', () => {
  it('reserves the current rule and author before calling its owner and records one fact', async () => {
    const { transaction, work, actions } = setup();
    const command = new ExecuteAutomationRule(work, actions, false, () => time);

    await expect(command.execute(input)).resolves.toEqual({ status: 'applied', runId });
    expect(transaction.reserve).toHaveBeenCalledWith({
      ruleId,
      sourceEventId,
      taskKey: 'CAD-482',
      ruleAuthorUserId: authorId,
      action,
    });
    expect(actions.execute).toHaveBeenCalledWith(pending, undefined);
    expect(transaction.settle).toHaveBeenCalledWith(runId, 'applied');
    expect(transaction.appendExecuted).toHaveBeenCalledOnce();
    expect(vi.mocked(transaction.reserve).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(actions.execute).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    ['deleted', null, input.fact],
    ['disabled', rule.setEnabled(false), input.fact],
    ['an automation actor', rule, { ...input.fact, actorType: 'automation' as const }],
  ])('ignores %s before reserving', async (_label, currentRule, fact) => {
    const { transaction, work, actions } = setup();
    vi.mocked(transaction.lockRule).mockResolvedValue(currentRule);
    await expect(
      new ExecuteAutomationRule(work, actions, false, () => time).execute({ ...input, fact }),
    ).resolves.toEqual({
      status: 'ignored',
    });
    expect(transaction.reserve).not.toHaveBeenCalled();
    expect(actions.execute).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'comment', body: 'Ready for review' },
    { type: 'notify', userId: authorId },
  ] as const)(
    'ignores a queued $type action when it cannot be reserved',
    async (unavailableAction) => {
      const { transaction, work, actions } = setup();
      const currentRule = AutomationRule.restore(
        { ...rule.snapshot(), action: unavailableAction },
        {
          statuses: ['todo'],
          priorities: ['high'],
        },
      );
      vi.mocked(transaction.lockRule).mockResolvedValue(currentRule);

      await expect(
        new ExecuteAutomationRule(work, actions, false, () => time).execute(input),
      ).resolves.toEqual({ status: 'ignored' });
      expect(transaction.reserve).not.toHaveBeenCalled();
      expect(actions.execute).not.toHaveBeenCalled();
    },
  );

  it('resumes the same decision after a lost downstream response even when the rule is gone', async () => {
    const { transaction, work, actions } = setup();
    vi.mocked(transaction.findBySource).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    vi.mocked(actions.execute).mockRejectedValueOnce(new Error('response lost'));
    const command = new ExecuteAutomationRule(work, actions, false, () => time);
    await expect(command.execute(input)).rejects.toThrow('response lost');
    expect(transaction.settle).not.toHaveBeenCalled();

    vi.mocked(transaction.findBySource).mockResolvedValue(pending);
    vi.mocked(transaction.lockRule).mockResolvedValue(null);
    await expect(command.execute(input)).resolves.toEqual({ status: 'applied', runId });
    expect(actions.execute).toHaveBeenLastCalledWith(pending, undefined);
    expect(transaction.reserve).toHaveBeenCalledOnce();
    expect(transaction.appendExecuted).toHaveBeenCalledOnce();
  });

  it.each([
    { type: 'comment', body: 'Le sprint est prêt pour la revue.' },
    { type: 'notify', userId: authorId },
  ] as const)(
    'retries a reserved $type with the original action and execution identity after a lost response',
    async (reservedAction) => {
      const { transaction, work, actions } = setup();
      const reserved: AutomationRun = { ...pending, action: reservedAction };
      vi.mocked(transaction.findBySource).mockResolvedValue(reserved);
      vi.mocked(actions.execute).mockRejectedValueOnce(new Error('response lost'));
      const command = new ExecuteAutomationRule(work, actions, false, () => time);

      await expect(command.execute(input)).rejects.toThrow('response lost');
      expect(transaction.settle).not.toHaveBeenCalled();
      await expect(command.execute(input)).resolves.toEqual({ status: 'applied', runId });

      expect(actions.execute).toHaveBeenCalledTimes(2);
      expect(actions.execute).toHaveBeenNthCalledWith(1, reserved, undefined);
      expect(actions.execute).toHaveBeenNthCalledWith(2, reserved, undefined);
      expect(transaction.reserve).not.toHaveBeenCalled();
      expect(transaction.appendExecuted).toHaveBeenCalledOnce();
    },
  );

  it('finds a concurrent reservation after acquiring a rule lock', async () => {
    const { transaction, work, actions } = setup();
    vi.mocked(transaction.findBySource).mockResolvedValueOnce(null).mockResolvedValueOnce(pending);
    vi.mocked(transaction.lockRule).mockResolvedValue(null);
    await expect(
      new ExecuteAutomationRule(work, actions, false, () => time).execute(input),
    ).resolves.toEqual({
      status: 'applied',
      runId,
    });
    expect(transaction.reserve).not.toHaveBeenCalled();
  });

  it('does not execute or emit again for an already completed run', async () => {
    const { transaction, work, actions } = setup();
    vi.mocked(transaction.findBySource).mockResolvedValue({ ...pending, status: 'applied' });
    await expect(
      new ExecuteAutomationRule(work, actions, false, () => time).execute(input),
    ).resolves.toEqual({
      status: 'applied',
      runId,
    });
    expect(actions.execute).not.toHaveBeenCalled();
    expect(transaction.appendExecuted).not.toHaveBeenCalled();
  });

  it('does not resend a pending action beyond the downstream receipt window', async () => {
    const { transaction, work, actions } = setup();
    vi.mocked(transaction.findBySource).mockResolvedValue(pending);
    const command = new ExecuteAutomationRule(
      work,
      actions,
      false,
      () => new Date(time.getTime() + 23 * 60 * 60 * 1_000),
    );
    await expect(command.execute(input)).rejects.toThrow('outside its downstream retry window');
    expect(actions.execute).not.toHaveBeenCalled();
    expect(transaction.settle).not.toHaveBeenCalled();
    expect(transaction.appendExecuted).not.toHaveBeenCalled();
  });

  it('resumes a pending action within the downstream receipt window', async () => {
    const { transaction, work, actions } = setup();
    vi.mocked(transaction.findBySource).mockResolvedValue(pending);
    const command = new ExecuteAutomationRule(
      work,
      actions,
      false,
      () => new Date(time.getTime() + 23 * 60 * 60 * 1_000 - 1),
    );
    await expect(command.execute(input)).resolves.toEqual({ status: 'applied', runId });
    expect(actions.execute).toHaveBeenCalledOnce();
  });

  it('forwards cancellation to the downstream action', async () => {
    const { work, actions } = setup();
    const controller = new AbortController();
    await new ExecuteAutomationRule(work, actions, false, () => time).execute(
      input,
      controller.signal,
    );
    expect(actions.execute).toHaveBeenCalledWith(pending, controller.signal);
  });

  it('does not start a downstream action after cancellation', async () => {
    const { transaction, work, actions } = setup();
    const controller = new AbortController();
    vi.mocked(transaction.reserve).mockImplementation(() => {
      controller.abort();
      return Promise.resolve(pending);
    });
    await expect(
      new ExecuteAutomationRule(work, actions, false, () => time).execute(input, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(actions.execute).not.toHaveBeenCalled();
    expect(transaction.settle).not.toHaveBeenCalled();
  });

  it('refuses a reservation whose timestamp is significantly in the future', async () => {
    const { transaction, work, actions } = setup();
    vi.mocked(transaction.findBySource).mockResolvedValue({
      ...pending,
      createdAt: new Date(time.getTime() + 60_001),
    });
    await expect(
      new ExecuteAutomationRule(work, actions, false, () => time).execute(input),
    ).rejects.toThrow('outside its downstream retry window');
    expect(actions.execute).not.toHaveBeenCalled();
  });

  it('does not emit for a no-op or for a transition settled by another worker', async () => {
    const { transaction, work, actions } = setup();
    vi.mocked(actions.execute).mockResolvedValueOnce('no_op').mockResolvedValueOnce('applied');
    const command = new ExecuteAutomationRule(work, actions, false, () => time);
    await expect(command.execute(input)).resolves.toEqual({ status: 'no_op', runId });
    vi.mocked(transaction.settle).mockResolvedValue(false);
    await expect(command.execute(input)).resolves.toEqual({ status: 'applied', runId });
    expect(transaction.appendExecuted).not.toHaveBeenCalled();
  });

  it('propagates an outbox failure to roll back the settlement', async () => {
    const { transaction, work, actions } = setup();
    vi.mocked(transaction.appendExecuted).mockRejectedValue(new Error('outbox unavailable'));
    await expect(
      new ExecuteAutomationRule(work, actions, false, () => time).execute(input),
    ).rejects.toThrow('outbox unavailable');
    expect(transaction.settle).toHaveBeenCalledWith(runId, 'applied');
  });

  it('rejects mismatched tenants and source identities', async () => {
    const { transaction, work, actions } = setup();
    const command = new ExecuteAutomationRule(work, actions, false, () => time);
    await expect(
      command.execute({ ...input, fact: { ...input.fact, organizationId: authorId } }),
    ).rejects.toThrow('organization');
    vi.mocked(transaction.findBySource).mockResolvedValue({ ...pending, taskKey: 'CAD-483' });
    await expect(command.execute(input)).rejects.toThrow('changed task');
    expect(actions.execute).not.toHaveBeenCalled();
  });
});
