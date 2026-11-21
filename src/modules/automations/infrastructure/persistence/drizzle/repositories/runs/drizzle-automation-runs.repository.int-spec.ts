import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { automationExecutedV1Schema } from '@cadenway/contracts/events/automation-service';
import { runWithOrganizationContext } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import { MessagingConnection, MessagingModule } from '@cadenway/nest-messaging';
import { outboxEvents } from '@cadenway/nest-messaging/outbox/schema';
import { OutboxWriter, OutboxWriterModule } from '@cadenway/nest-messaging/outbox/writer';
import { Test } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AutomationExecutedOutbox } from '../../../../messaging/outbox/runs/automation-executed-outbox.adapter.js';
import { automationRuns } from '../../schemas/runs/automation-runs.schema.js';
import { DrizzleAutomationRunsUnitOfWork } from '../../transactions/runs/drizzle-automation-runs.unit-of-work.js';
import { DrizzleAutomationRunsReader } from './drizzle-automation-runs.repository.js';

const project = `cadenway-automation-runs-test-${String(process.pid)}`;
const organization = '01938f6e-0000-7000-8000-000000000001';
const otherOrganization = '01938f6e-0000-7000-8000-000000000002';
const actor = '01938f6e-0000-7000-8000-000000000003';
const ruleId = '01938f6e-0000-7000-8000-000000000004';
const eventId = '01938f6e-0000-7000-8000-000000000005';
const vocabulary = { statuses: ['todo'], priorities: ['high'] } as const;
const reservation = {
  ruleId,
  sourceEventId: eventId,
  ruleAuthorUserId: actor,
  taskKey: 'CAD-482',
  action: { type: 'priority', priority: 'high' },
} as const;

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

describe('automation run persistence', () => {
  let pool: pg.Pool | undefined;
  let runner: TenantTransactionRunner;
  let unit: DrizzleAutomationRunsUnitOfWork;
  let reader: DrizzleAutomationRunsReader;

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
    runner = new TenantTransactionRunner(pool);
    unit = new DrizzleAutomationRunsUnitOfWork(runner, vocabulary, () => Promise.resolve());
    reader = new DrizzleAutomationRunsReader(runner);
  });

  afterAll(async () => {
    await pool?.end();
    compose('down', '--volumes', '--remove-orphans');
  });

  it('reserves one immutable intent across concurrent deliveries and isolates tenants', async () => {
    const [first, replay] = await Promise.all(
      [
        reservation,
        { ...reservation, action: { type: 'priority' as const, priority: 'other' } },
      ].map((input) =>
        inOrganization(organization, () =>
          unit.run(organization, (transaction) => transaction.reserve(input)),
        ),
      ),
    );
    expect(first?.id).toEqual(replay?.id);
    expect(first?.action).toEqual(replay?.action);
    expect(first?.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab]/u);
    expect(
      await inOrganization(otherOrganization, () =>
        unit.run(otherOrganization, (transaction) => transaction.findBySource(ruleId, eventId)),
      ),
    ).toBeNull();
    const rls = await pool?.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.automation_runs'::regclass",
    );
    expect(rls?.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    await expect(
      inOrganization(otherOrganization, () =>
        unit.run(organization, (transaction) => transaction.findBySource(ruleId, eventId)),
      ),
    ).rejects.toThrow();
  });

  it('settles once and rolls the outcome back when the transaction-bound event append fails', async () => {
    const pending = await inOrganization(organization, () =>
      unit.run(organization, (transaction) => transaction.findBySource(ruleId, eventId)),
    );
    if (pending === null) throw new Error('Missing reserved run.');
    const failing = new DrizzleAutomationRunsUnitOfWork(runner, vocabulary, () =>
      Promise.reject(new Error('outbox unavailable')),
    );
    await expect(
      inOrganization(organization, () =>
        failing.run(organization, async (transaction) => {
          expect(await transaction.settle(pending.id, 'applied')).toBe(true);
          await transaction.appendExecuted(pending);
        }),
      ),
    ).rejects.toThrow('outbox unavailable');
    const afterRollback = await inOrganization(organization, () =>
      unit.run(organization, (transaction) => transaction.findBySource(ruleId, eventId)),
    );
    expect(afterRollback?.status).toBe('pending');
    const outcomes = await Promise.all(
      [1, 2].map(() =>
        inOrganization(organization, () =>
          unit.run(organization, (transaction) => transaction.settle(pending.id, 'applied')),
        ),
      ),
    );
    expect(outcomes.sort()).toEqual([false, true]);
  });

  it('pages only applied runs under a fixed upper bound and a 100-candidate budget', async () => {
    const noOp = await inOrganization(organization, () =>
      unit.run(organization, async (transaction) => {
        const run = await transaction.reserve({
          ...reservation,
          sourceEventId: '01938f6e-0000-7003-8000-000000000001',
        });
        expect(await transaction.settle(run.id, 'no_op')).toBe(true);
        return run.id;
      }),
    );
    await inOrganization(organization, () =>
      runner.run(async (scope) => {
        await scope.db.insert(automationRuns).values(
          Array.from({ length: 104 }, (_, index) => ({
            organizationId: organization,
            ruleId,
            sourceEventId: `01938f6e-0000-7001-8000-${String(index).padStart(12, '0')}`,
            ruleAuthorUserId: actor,
            taskKey: 'CAD-482',
            action: reservation.action,
            status: 'applied' as const,
            executedAt: new Date('2026-11-20T08:00:00.000Z'),
          })),
        );
      }),
    );
    const first = await inOrganization(organization, () =>
      reader.list(organization, { upper: null, after: null, limit: 25, remaining: 100 }),
    );
    expect(first.items).toHaveLength(25);
    expect(first.upper).not.toBeNull();
    const seen = new Set(first.items.map((run) => run.id));
    const later = await inOrganization(organization, () =>
      runner.run(async (scope) => {
        const rows = await scope.db
          .insert(automationRuns)
          .values({
            organizationId: organization,
            ruleId,
            sourceEventId: '01938f6e-0000-7002-8000-000000000001',
            ruleAuthorUserId: actor,
            taskKey: 'CAD-482',
            action: reservation.action,
            status: 'applied',
            executedAt: new Date('2027-11-20T08:00:00.000Z'),
          })
          .returning({ id: automationRuns.id });
        return rows[0]?.id;
      }),
    );
    let page = first;
    while (page.next !== null) {
      page = await inOrganization(organization, () =>
        reader.list(organization, {
          upper: first.upper,
          after: page.next,
          limit: 25,
          remaining: page.remaining,
        }),
      );
      for (const run of page.items) seen.add(run.id);
    }
    expect(seen.size).toBe(100);
    expect(seen.has(noOp)).toBe(false);
    expect(seen.has(later ?? '')).toBe(false);
    expect(page.remaining).toBe(0);
    expect(
      await inOrganization(otherOrganization, () =>
        reader.list(otherOrganization, { upper: null, after: null, limit: 100, remaining: 100 }),
      ),
    ).toEqual({ items: [], upper: null, next: null, remaining: 0 });
  });

  it('writes one outbox fact with the recorded execution time across competing settlements', async () => {
    const messaging = await Test.createTestingModule({
      imports: [
        MessagingModule.forRoot({
          service: 'automation-service',
          servers: 'nats://127.0.0.1:4222',
          manageStreams: false,
          deadLetterWorker: false,
        }),
        OutboxWriterModule.forRoot(),
      ],
    })
      .overrideProvider(MessagingConnection)
      .useValue({ stopDeliveryAvailability: (): void => undefined })
      .compile();
    try {
      const outbox = new AutomationExecutedOutbox(messaging.get(OutboxWriter));
      const executing = new DrizzleAutomationRunsUnitOfWork(runner, vocabulary, (scope, run) =>
        outbox.append(scope, run),
      );
      const sourceEventId = '01938f6e-0000-7004-8000-000000000001';
      const pending = await inOrganization(organization, () =>
        executing.run(organization, (transaction) =>
          transaction.reserve({ ...reservation, sourceEventId }),
        ),
      );

      const settle = () =>
        inOrganization(organization, () =>
          executing.run(organization, async (transaction) => {
            const changed = await transaction.settle(pending.id, 'applied');
            if (changed) await transaction.appendExecuted(pending);
            return changed;
          }),
        );
      expect((await Promise.all([settle(), settle()])).sort()).toEqual([false, true]);
      expect(await settle()).toBe(false);

      const applied = await inOrganization(organization, () =>
        executing.run(organization, (transaction) =>
          transaction.findBySource(ruleId, sourceEventId),
        ),
      );
      const rows = await inOrganization(organization, () =>
        runner.run((scope) =>
          scope.db
            .select({ payload: outboxEvents.payload, subject: outboxEvents.subject })
            .from(outboxEvents)
            .where(
              and(
                eq(outboxEvents.organizationId, organization),
                sql`${outboxEvents.payload}->>'executionId' = ${pending.id}`,
              ),
            ),
        ),
      );
      expect(rows).toHaveLength(1);
      const fact = automationExecutedV1Schema.parse(rows[0]?.payload);
      expect(rows[0]?.subject).toBe('evt.automation.executed.v1');
      expect(fact.occurredAt).toBe(applied?.executedAt?.toISOString());
      expect(fact.actor).toEqual({ type: 'automation', id: ruleId });
      expect(fact.executionId).toBe(pending.id);
    } finally {
      await messaging.close();
    }
  });
});
