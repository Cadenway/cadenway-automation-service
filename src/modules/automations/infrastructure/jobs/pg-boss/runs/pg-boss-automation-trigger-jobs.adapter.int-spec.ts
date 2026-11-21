import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { runWithOrganizationContext } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import { provisionJobs } from '@cadenway/nest-jobs/provisioning';
import { JobProducer, JobsRuntimeModule } from '@cadenway/nest-jobs/runtime';
import { Test, type TestingModule } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTOMATION_TASK_TRIGGER_QUEUE } from '../../../../../../config/job-queues.js';
import type { AutomationTaskTriggerJob } from '../../../../application/models/runs/automation-task-trigger-job.model.js';
import { PgBossAutomationTriggerJobs } from './pg-boss-automation-trigger-jobs.adapter.js';

const project = `cadenway-automation-trigger-test-${String(process.pid)}`;
const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const eventId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const durable = 'automation-service__run-task-created-rules';

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

function inOrganization<T>(work: () => Promise<T>): Promise<T> {
  return runWithOrganizationContext(
    { organizationId, actor: { type: 'system', id: 'task-service' }, role: null, scopes: [] },
    work,
  );
}

describe('Automation trigger jobs', () => {
  let database: pg.Pool | undefined;
  let runtime: TestingModule | undefined;
  let runner: TenantTransactionRunner;
  let jobs: PgBossAutomationTriggerJobs;
  const signal = new AbortController().signal;

  beforeAll(async () => {
    compose('up', '--detach', '--wait', '--wait-timeout', '120', 'postgres');
    const port = compose('port', 'postgres', '5432').trim().split(':').at(-1);
    if (port === undefined) throw new Error('PostgreSQL port is unavailable.');
    const migrator = new pg.Pool({
      connectionString: `postgres://automation_migrator:automation_migrator@127.0.0.1:${port}/automation`,
    });
    try {
      await migrate(drizzle({ client: migrator }), { migrationsFolder: resolve('migrations') });
      await provisionJobs({
        connection: {
          connectionString: `postgres://automation_migrator:automation_migrator@127.0.0.1:${port}/automation`,
        },
        appRole: 'automation_app',
        queues: [AUTOMATION_TASK_TRIGGER_QUEUE],
      });
    } finally {
      await migrator.end();
    }
    const connectionString = `postgres://automation_app:automation_app@127.0.0.1:${port}/automation`;
    database = new pg.Pool({ connectionString });
    runner = new TenantTransactionRunner(database);
    runtime = await Test.createTestingModule({
      imports: [
        JobsRuntimeModule.forRoot({
          connection: { connectionString },
          queues: [AUTOMATION_TASK_TRIGGER_QUEUE],
          capabilities: ['producer'],
          poolSize: 2,
        }),
      ],
    }).compile();
    await runtime.init();
    jobs = new PgBossAutomationTriggerJobs(runner, runtime.get(JobProducer));
  });

  afterAll(async () => {
    try {
      await runtime?.close();
      await database?.end();
    } finally {
      compose('down', '--volumes', '--remove-orphans');
    }
  });

  it('rolls back the event receipt and its initial page together, then enqueues just one on retry', async () => {
    const initial: AutomationTaskTriggerJob = {
      kind: 'page',
      after: null,
      source: {
        id: eventId,
        occurredAt: new Date().toISOString(),
        taskKey: 'CAD-482',
        trigger: { type: 'created', actorType: 'user' },
      },
    };
    const counts = () =>
      inOrganization(() =>
        runner.run(async ({ client }) => {
          const result = await client.query(
            `select
               (select count(*)::int from processed_events where consumer = $1 and event_id = $2) as receipts,
               (select count(*)::int from pgboss.job where name = $3) as jobs`,
            [durable, eventId, AUTOMATION_TASK_TRIGGER_QUEUE.name],
          );
          return result.rows[0];
        }),
      );
    const admit = (rollback: boolean) =>
      inOrganization(() =>
        runner.run(async ({ client }) => {
          await client.query('insert into processed_events (consumer, event_id) values ($1, $2)', [
            durable,
            eventId,
          ]);
          await jobs.enqueue(organizationId, [initial, initial], signal);
          expect(await counts()).toEqual({ receipts: 1, jobs: 1 });
          if (rollback) throw new Error('Force the broker transaction to roll back');
        }),
      );

    await expect(admit(true)).rejects.toThrow('Force the broker transaction to roll back');
    expect(await counts()).toEqual({ receipts: 0, jobs: 0 });
    await admit(false);
    expect(await counts()).toEqual({ receipts: 1, jobs: 1 });
  });
});
