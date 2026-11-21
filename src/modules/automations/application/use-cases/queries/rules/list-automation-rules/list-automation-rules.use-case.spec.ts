import { describe, expect, it, vi } from 'vitest';

import type { AutomationRulesReader } from '../../../../ports/outbound/persistence/rules/automation-rules-reader.port.js';
import { ListAutomationRules } from './list-automation-rules.use-case.js';

describe('ListAutomationRules', () => {
  it('passes the trusted tenant, position, and bounded size to the reader', async () => {
    const page = { items: [], next: null };
    const reader: AutomationRulesReader = { list: vi.fn().mockResolvedValue(page) };
    const after = { createdAt: new Date('2026-11-20T08:05:00Z'), ruleId: 'rule' };
    await expect(
      new ListAutomationRules(reader).execute({ organizationId: 'tenant', after, limit: 100 }),
    ).resolves.toBe(page);
    expect(reader.list).toHaveBeenCalledWith('tenant', { after, limit: 100 });
  });

  it.each([0, 101, 1.5, Number.NaN])('rejects page size %s before querying', (limit) => {
    const reader: AutomationRulesReader = { list: vi.fn() };
    expect(() =>
      new ListAutomationRules(reader).execute({ organizationId: 'tenant', after: null, limit }),
    ).toThrow(RangeError);
    expect(reader.list).not.toHaveBeenCalled();
  });
});
