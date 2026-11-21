import {
  AUTOMATION_EXECUTED_V1,
  eventSchemas,
} from '@cadenway/contracts/events/automation-service';
import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import type { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';
import { describe, expect, it, vi } from 'vitest';

import type { AutomationRun } from '../../../../application/models/runs/automation-run.model.js';
import { AutomationExecutedOutbox } from './automation-executed-outbox.adapter.js';

const envelope = {
  id: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d14',
  occurredAt: '2026-11-08T09:00:05.123Z',
};
const run: AutomationRun = {
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
  id: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d11',
  ruleId: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d12',
  sourceEventId: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d13',
  taskKey: 'CAD-482',
  ruleAuthorUserId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30',
  action: { type: 'comment', body: 'The rule comment stays with the task.' },
  status: 'applied',
  createdAt: new Date('2026-11-08T09:00:00.000Z'),
  updatedAt: new Date(envelope.occurredAt),
  executedAt: new Date(envelope.occurredAt),
};

function setup() {
  const append = vi.fn<OutboxWriter['append']>().mockResolvedValue(envelope);
  const writer = { append } as unknown as OutboxWriter;
  const scope = {
    kind: 'tenant',
    organizationId: run.organizationId,
  } as TransactionScope<DatabaseSchema>;
  return { append, adapter: new AutomationExecutedOutbox(writer), scope };
}

describe('AutomationExecutedOutbox', () => {
  it('appends the published fact in the same transaction without the author or action content', async () => {
    const { append, adapter, scope } = setup();

    await adapter.append(scope, run);

    expect(append).toHaveBeenCalledOnce();
    const [activeScope, schemas, name, data] = append.mock.calls[0] ?? [];
    expect(activeScope).toBe(scope);
    expect(schemas).toBe(eventSchemas);
    expect(name).toBe(AUTOMATION_EXECUTED_V1);
    const fact = eventSchemas[AUTOMATION_EXECUTED_V1].parse({ ...data, ...envelope });
    expect(fact).toEqual({
      ...envelope,
      organizationId: run.organizationId,
      actor: { type: 'automation', id: run.ruleId },
      version: 1,
      executionId: run.id,
      ruleId: run.ruleId,
      triggerEventId: run.sourceEventId,
      taskKey: 'CAD-482',
      actionType: 'comment',
    });
  });

  it('requires a transaction scoped to the run organization', async () => {
    const { append, adapter, scope } = setup();
    const otherTenant = {
      ...scope,
      organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2e',
    };

    await expect(adapter.append(otherTenant, run)).rejects.toThrow('tenant transaction');
    await expect(adapter.append({ ...scope, kind: 'system' }, run)).rejects.toThrow(
      'tenant transaction',
    );
    expect(append).not.toHaveBeenCalled();
  });

  it('refuses a pending run, a no-op and a success without its recording time', async () => {
    const { append, adapter, scope } = setup();

    for (const status of ['pending', 'no_op', 'applied'] as const) {
      await expect(adapter.append(scope, { ...run, status, executedAt: null })).rejects.toThrow(
        'recorded successful automation run',
      );
    }
    expect(append).not.toHaveBeenCalled();
  });

  it('rejects the settlement when the writer fails or assigns a different occurrence time', async () => {
    const { append, adapter, scope } = setup();
    const failure = new Error('Outbox unavailable.');
    append
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ ...envelope, occurredAt: '2026-11-08T09:00:05.124Z' });

    await expect(adapter.append(scope, run)).rejects.toBe(failure);
    await expect(adapter.append(scope, run)).rejects.toThrow(
      'does not match the recorded execution',
    );
  });
});
