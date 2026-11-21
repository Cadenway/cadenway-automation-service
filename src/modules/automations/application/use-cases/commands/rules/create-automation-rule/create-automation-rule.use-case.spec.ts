import { describe, expect, it, vi } from 'vitest';

import { AutomationRule } from '../../../../../domain/aggregates/rules/automation-rule.aggregate.js';
import type { AutomationRulesTransaction } from '../../../../ports/outbound/transactions/rules/automation-rules-transaction.port.js';
import type { AutomationRulesUnitOfWork } from '../../../../ports/outbound/transactions/rules/automation-rules-unit-of-work.port.js';
import type { AutomationRecipientAuthority } from '../../../../ports/outbound/authorization/rules/automation-recipient-authority.port.js';
import { DeleteAutomationRule } from '../delete-automation-rule/delete-automation-rule.use-case.js';
import { SetAutomationRuleEnabled } from '../set-automation-rule-enabled/set-automation-rule-enabled.use-case.js';
import { CreateAutomationRule } from './create-automation-rule.use-case.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b31';
const ruleId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const userId = '019a5f3c-a0b1-7c2d-9e3f-5a6b7c8d9e32';
const vocabulary = { statuses: ['todo'], priorities: ['high'] };
const definition = {
  organizationId,
  ruleAuthorUserId: userId,
  ruleId,
  createdAt: new Date('2026-11-20T08:05:00Z'),
  trigger: { type: 'created' } as const,
  action: { type: 'assign', userId } as const,
};

function setup(): {
  readonly transaction: AutomationRulesTransaction;
  readonly work: AutomationRulesUnitOfWork;
  readonly recipients: AutomationRecipientAuthority;
} {
  const transaction: AutomationRulesTransaction = {
    allocateIdentity: vi.fn().mockResolvedValue({ ruleId, createdAt: definition.createdAt }),
    find: vi.fn().mockResolvedValue(AutomationRule.create(definition, vocabulary)),
    insert: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(true),
    delete: vi.fn().mockResolvedValue(true),
  };
  const recipients: AutomationRecipientAuthority = {
    isActiveRecipient: vi.fn().mockResolvedValue(true),
  };
  const run = async <T>(
    tenant: string,
    work: (value: AutomationRulesTransaction) => Promise<T>,
  ): Promise<T> => {
    expect(tenant).toBe(organizationId);
    return work(transaction);
  };
  return { transaction, work: { run }, recipients };
}

describe('automation rule writes', () => {
  it('creates a tenant rule only after recipient eligibility is confirmed', async () => {
    const { work, transaction, recipients } = setup();
    const command = new CreateAutomationRule(work, vocabulary, recipients);

    const result = await command.execute({
      organizationId,
      ruleAuthorUserId: userId,
      trigger: definition.trigger,
      action: definition.action,
    });

    expect(result).toMatchObject({
      status: 'created',
      rule: { ruleId, ruleAuthorUserId: userId, version: 1, enabled: true },
    });
    expect(recipients.isActiveRecipient).toHaveBeenCalledWith(organizationId, userId);
    expect(transaction.insert).toHaveBeenCalledOnce();
  });

  it('refuses an inactive recipient without inserting a rule', async () => {
    const { work, transaction, recipients } = setup();
    vi.mocked(recipients.isActiveRecipient).mockResolvedValue(false);

    await expect(
      new CreateAutomationRule(work, vocabulary, recipients).execute({
        organizationId,
        ruleAuthorUserId: userId,
        trigger: definition.trigger,
        action: definition.action,
      }),
    ).resolves.toEqual({ status: 'recipient-not-active' });
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('propagates unavailable membership evidence without inserting a rule', async () => {
    const { work, transaction, recipients } = setup();
    vi.mocked(recipients.isActiveRecipient).mockRejectedValue(new Error('authority unavailable'));

    await expect(
      new CreateAutomationRule(work, vocabulary, recipients).execute({
        organizationId,
        ruleAuthorUserId: userId,
        trigger: definition.trigger,
        action: definition.action,
      }),
    ).rejects.toThrow('authority unavailable');
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('checks the version before a no-op and saves only a genuine state change', async () => {
    const { work, transaction } = setup();
    const command = new SetAutomationRuleEnabled(work);
    const input = { organizationId, ruleId, enabled: true, expectedVersion: 1 };

    await expect(command.execute({ ...input, expectedVersion: 2 })).resolves.toEqual({
      status: 'version-mismatch',
      version: 1,
    });
    await expect(command.execute(input)).resolves.toMatchObject({
      status: 'updated',
      rule: { version: 1, enabled: true },
    });
    expect(transaction.save).not.toHaveBeenCalled();
    await expect(command.execute({ ...input, enabled: false })).resolves.toMatchObject({
      status: 'updated',
      rule: { version: 2, enabled: false, trigger: definition.trigger, action: definition.action },
    });
    expect(transaction.save).toHaveBeenCalledOnce();
  });

  it('returns not found and protects the version before deleting', async () => {
    const { work, transaction } = setup();
    const command = new DeleteAutomationRule(work);
    const input = { organizationId, ruleId, expectedVersion: 2 };

    await expect(command.execute(input)).resolves.toEqual({
      status: 'version-mismatch',
      version: 1,
    });
    expect(transaction.delete).not.toHaveBeenCalled();
    await expect(command.execute({ ...input, expectedVersion: null })).resolves.toEqual({
      status: 'deleted',
    });
    expect(transaction.delete).toHaveBeenCalledWith(ruleId, 1);
    vi.mocked(transaction.find).mockResolvedValue(null);
    await expect(command.execute(input)).resolves.toEqual({ status: 'not-found' });
  });

  it('fails the transaction when an unexpectedly changed locked row cannot be saved', async () => {
    const { work, transaction } = setup();
    vi.mocked(transaction.save).mockResolvedValue(false);
    await expect(
      new SetAutomationRuleEnabled(work).execute({
        organizationId,
        ruleId,
        enabled: false,
        expectedVersion: null,
      }),
    ).rejects.toThrow('Locked automation rule changed');
  });
});
