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
const vocabulary = { statuses: ['todo'], priorities: ['high'] } as const;

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
});
