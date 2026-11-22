import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { runWithOrganizationContext } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AutomationRule } from '../../../../../domain/aggregates/rules/automation-rule.aggregate.js';
import { DrizzleAutomationRulesUnitOfWork } from '../../transactions/rules/drizzle-automation-rules.unit-of-work.js';
import { DrizzleAutomationRulesReader } from './drizzle-automation-rules.repository.js';

const project = `cadenway-automation-rules-test-${String(process.pid)}`;
const organization = '01938f6e-0000-7000-8000-000000000001';
const otherOrganization = '01938f6e-0000-7000-8000-000000000002';
const actor = '01938f6e-0000-7000-8000-000000000003';
const vocabulary = { statuses: ['todo', 'review'], priorities: ['high'] } as const;

function compose(...args: readonly string[]): string {
  return execFileSync(
    'docker',
    ['compose', '--project-name', project, '--file', resolve('compose.dev.yaml'), ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, DEV_POSTGRES_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function inOrganization<T>(id: string, work: () => Promise<T>): Promise<T> {
  return runWithOrganizationContext(
    { organizationId: id, actor: { type: 'user', id: actor }, role: null, scopes: [] },
    work,
  );
}

describe('automation rule persistence', () => {
  let pool: pg.Pool | undefined;
  let unit: DrizzleAutomationRulesUnitOfWork;
  let reader: DrizzleAutomationRulesReader;

  beforeAll(async () => {
    compose('up', '--detach', '--wait', '--wait-timeout', '120', 'postgres');
    const port = compose('port', 'postgres', '5432').trim().split(':').at(-1);
    if (port === undefined) throw new Error('PostgreSQL port is unavailable.');
    const migrator = new pg.Pool({
      connectionString: `postgres://automation_migrator:automation_migrator@127.0.0.1:${port}/automation`,
    });
    try {
      await migrate(drizzle({ client: migrator }), { migrationsFolder: resolve('migrations') });
    } finally {
      await migrator.end();
    }
    pool = new pg.Pool({
      connectionString: `postgres://automation_app:automation_app@127.0.0.1:${port}/automation`,
    });
    const runner = new TenantTransactionRunner(pool);
    unit = new DrizzleAutomationRulesUnitOfWork(runner, vocabulary);
    reader = new DrizzleAutomationRulesReader(runner, vocabulary);
  });

  afterAll(async () => {
    await pool?.end();
    compose('down', '--volumes', '--remove-orphans');
  });

  it('pages stable tenant rules and checks versions before updating or deleting', async () => {
    const ids = await inOrganization(organization, () =>
      unit.run(organization, async (transaction) => {
        const result: string[] = [];
        for (let index = 0; index < 3; index += 1) {
          const identity = await transaction.allocateIdentity();
          const rule = AutomationRule.create(
            {
              ...identity,
              organizationId: organization,
              ruleAuthorUserId: '019a5f3c-a0b1-7c2d-9e3f-5a6b7c8d9e32',
              trigger: { type: 'created' },
              action: { type: 'priority', priority: 'high' },
            },
            vocabulary,
          );
          await transaction.insert(rule);
          result.push(identity.ruleId);
        }
        return result;
      }),
    );

    const first = await inOrganization(organization, () =>
      reader.list(organization, { after: null, limit: 2 }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const second = await inOrganization(organization, () =>
      reader.list(organization, { after: first.next, limit: 2 }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.next).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((rule) => rule.snapshot().ruleId)),
    ).toEqual(new Set(ids));
    expect(
      await inOrganization(otherOrganization, () =>
        reader.list(otherOrganization, { after: null, limit: 100 }),
      ),
    ).toEqual({ items: [], next: null });

    const ruleId = ids[0];
    if (ruleId === undefined) throw new Error('Missing inserted rule.');
    expect(
      await inOrganization(otherOrganization, () =>
        unit.run(otherOrganization, (transaction) => transaction.find(ruleId)),
      ),
    ).toBeNull();
    const rls = await pool?.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.automation_rules'::regclass",
    );
    expect(rls?.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    await inOrganization(organization, () =>
      unit.run(organization, async (transaction) => {
        const stored = await transaction.find(ruleId);
        if (stored === null) throw new Error('Missing inserted rule.');
        expect(await transaction.save(stored.setEnabled(false), 1)).toBe(true);
        expect(await transaction.delete(ruleId, 1)).toBe(false);
        expect(await transaction.delete(ruleId, 2)).toBe(true);
      }),
    );
    await expect(
      inOrganization(otherOrganization, () =>
        unit.run(organization, (transaction) => transaction.find(ruleId)),
      ),
    ).rejects.toThrow();
  });

  it('filters trigger candidates before computing each page and its lookahead', async () => {
    const tenant = '01938f6e-0000-7000-8000-000000000004';
    const occurredAt = new Date('2026-11-21T08:00:00.000Z');
    const future = new Date('2026-11-21T08:00:00.001Z');
    const trigger = { type: 'status', status: 'todo' } as const;
    const action = { type: 'priority', priority: 'high' } as const;
    const fields = { createdAt: occurredAt, trigger, action, enabled: true, version: 1 };
    const definitions = [
      { ...fields, enabled: false },
      { ...fields, trigger: { type: 'created' } },
      { ...fields, trigger: { type: 'status', status: 'review' } },
      { ...fields, action: { type: 'comment', body: 'Ready for review' } },
      { ...fields, action: { type: 'notify', userId: actor } },
      { ...fields, createdAt: future },
      fields,
      { ...fields, action: { type: 'assign', userId: actor } },
    ] as const;
    const ids = await inOrganization(tenant, () =>
      unit.run(tenant, async (transaction) => {
        const result: string[] = [];
        for (const [index, definition] of definitions.entries()) {
          const ruleId = `01938f6e-0000-7000-8000-00000000008${String(index)}`;
          const rule = AutomationRule.restore(
            { ...definition, organizationId: tenant, ruleAuthorUserId: actor, ruleId },
            vocabulary,
          );
          await transaction.insert(rule);
          result.push(ruleId);
        }
        return result;
      }),
    );
    const query = {
      after: null,
      occurredAt,
      trigger,
      availableActions: ['assign', 'priority'],
      limit: 1,
    } as const;
    const first = await inOrganization(tenant, () => reader.listTriggerCandidates(tenant, query));
    expect(first.items.map((rule) => rule.snapshot().ruleId)).toEqual([ids[6]]);
    expect(first.next).toEqual({ createdAt: occurredAt, ruleId: ids[6] });
    const last = await inOrganization(tenant, () =>
      reader.listTriggerCandidates(tenant, { ...query, after: first.next }),
    );
    expect(last.items.map((rule) => rule.snapshot().ruleId)).toEqual([ids[7]]);
    expect(last.next).toBeNull();
    const all = await inOrganization(tenant, () =>
      reader.listTriggerCandidates(tenant, {
        ...query,
        limit: 100,
        availableActions: ['assign', 'priority', 'comment', 'notify'],
      }),
    );
    expect(all.items.map((rule) => rule.snapshot().ruleId)).toEqual([
      ids[3],
      ids[4],
      ids[6],
      ids[7],
    ]);
    await expect(
      inOrganization(otherOrganization, () => reader.listTriggerCandidates(tenant, query)),
    ).rejects.toThrow('Rule read organization does not match the tenant transaction');
    const management = await inOrganization(tenant, () =>
      reader.list(tenant, { after: null, limit: 100 }),
    );
    expect(management.items).toHaveLength(definitions.length);
  });
});
