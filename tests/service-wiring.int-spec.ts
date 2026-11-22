import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  createApplication,
  InternalTokenSigner,
  InternalTokenVerifier,
  loadConfig,
  runWithOrganizationContext,
} from '@cadenway/nest-common';
import type {
  Ed25519PrivateJwk,
  Ed25519PublicJwk,
  OrganizationContext,
} from '@cadenway/nest-common';
import { SystemTransactionRunner, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { JobProducer } from '@cadenway/nest-jobs/runtime';
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { taskCreatedV1Schema } from '@cadenway/contracts/events/task-service';

import { AppModule } from '../src/app.module.js';
import { appConfigSchema } from '../src/config/app-config.js';
import {
  AUTOMATION_PURGE_RECEIPTS_QUEUE,
  AUTOMATION_TASK_TRIGGER_QUEUE,
} from '../src/config/job-queues.js';

// The service as main.ts assembles it, on a disposable PostgreSQL and NATS. `@cadenway/nest-testing`
// does not export its container fixtures yet and a service never depends on `testcontainers` itself,
// so the dependencies are those of compose.dev.yaml, started as a throwaway Compose project on free
// ports: PostgreSQL with the two roles of cadenway-ops, NATS with its authorization (the
// `automation` user, its subjects, the inbox prefix `_INBOX.automation`) and its three streams.

/** Compose file of the development dependencies. */
const composeFile: string = fileURLToPath(new URL('../compose.dev.yaml', import.meta.url));

/** Throwaway project name: it never touches the data of the developer's own dev stack. */
const project = `cadenway-automation-service-test-${String(process.pid)}`;

/**
 * Host port of NATS. Fixed for the run, unlike the ephemeral port of PostgreSQL: the service must
 * find NATS at the same address after the test restarts it, and Docker gives an ephemeral mapping a
 * new port at each start.
 */
let natsHostPort = '0';

/** Atelier Nord, the organization of the mockup. */
const atelierNordId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';

/** Another organization, which must never see a row of Atelier Nord. */
const otherOrganizationId = '01938f6e-0000-7000-8000-000000000002';

/** Camille Martin (CM), the member of Atelier Nord the mockup signs in as. */
const camilleMartinId = '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24';

/** Number of migrations applied on an empty test database. */
const migrationCount = 5;

/** The tables of the platform module, as the kit names them. */
const platformTables = [
  'event_versions',
  'idempotency_keys',
  'outbox_events',
  'processed_events',
] as const;

/**
 * Runs `docker compose` on the throwaway project.
 *
 * @param args - Compose command and its arguments.
 * @returns The standard output.
 */
function compose(...args: readonly string[]): string {
  return execFileSync(
    'docker',
    ['compose', '--project-name', project, '--file', composeFile, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, DEV_POSTGRES_PORT: '0', DEV_NATS_PORT: natsHostPort },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/**
 * Runs the NATS command line of the `nats-streams` container against the broker of the project.
 *
 * @param env - Variables that replace the `admin` credentials of the container for this call.
 * @param args - Arguments of the `nats` command.
 * @returns Whether the broker accepted the command.
 */
function brokerAccepts(env: Readonly<Record<string, string>>, ...args: readonly string[]): boolean {
  const variables = Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]);
  try {
    compose('exec', '-T', ...variables, 'nats-streams', 'nats', '--timeout', '2s', ...args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a port of the loopback interface that nothing listens on.
 *
 * @returns A free port, released before it is returned.
 */
async function freePort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('The probe server has no TCP address.'));
        } else {
          resolve(String(address.port));
        }
      });
    });
  });
}

/**
 * Reads the published host port of a service of the project.
 *
 * @param service - Compose service.
 * @param port - Port inside the container.
 * @returns The host port.
 */
function hostPort(service: string, port: string): string {
  return compose('port', service, port).trim().split(':').at(-1) ?? '';
}

/**
 * Creates an Ed25519 key pair in the JWK forms the internal token uses.
 *
 * @returns The public key for the verifier and the private key for a signer.
 */
function keyPair(): {
  readonly publicJwk: Ed25519PublicJwk;
  readonly privateJwk: Ed25519PrivateJwk;
} {
  const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  if (x === undefined || d === undefined) {
    throw new Error('Node returned an Ed25519 JWK without its key material.');
  }
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x, kid: 'test-api-gateway' };
  return { publicJwk, privateJwk: { ...publicJwk, d } };
}

/**
 * The organization context of a member of an organization, as the internal token gives it.
 *
 * @param organizationId - Organization of the context.
 * @returns The context the tenant runner reads.
 */
function memberOf(organizationId: string): OrganizationContext {
  return {
    organizationId,
    actor: { type: 'user', id: camilleMartinId },
    role: null,
    scopes: [],
  };
}

/**
 * Applies the migrations with `src/migrate.ts`, the entry point of the migration container, as
 * the migrator role. Each call imports the module afresh, as each container start runs it once.
 */
async function runMigrator(): Promise<void> {
  vi.resetModules();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await import('../src/migrate.js');
  } finally {
    log.mockRestore();
  }
}

/** Releases the shutdown held by `ShutdownGate`. */
let releaseShutdown: () => void = () => undefined;

/** Settles once `releaseShutdown` is called. */
const shutdownReleased = new Promise<void>((resolve) => {
  releaseShutdown = resolve;
});

/**
 * Holds the shutdown after readiness turned down and before the listener closes, the way a slow
 * handler or relay pass would, so the probes can be read during the stop.
 */
@Injectable()
class ShutdownGate implements BeforeApplicationShutdown {
  public async beforeApplicationShutdown(): Promise<void> {
    await shutdownReleased;
  }
}

/** A route of the application that declares no exemption, like every business route will. */
@Controller('internal/v1/wiring-probe')
class WiringProbeController {
  @Get()
  public probe(): { readonly reached: true } {
    return { reached: true };
  }
}

describe('automation-service wiring', () => {
  const gateway = keyPair();
  const automation = keyPair();
  const taskCalls: {
    readonly path: string | undefined;
    readonly key: string | string[] | undefined;
    readonly body: unknown;
    readonly principal: unknown;
  }[] = [];
  let verifier: InternalTokenVerifier;
  const task = createHttpServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk: string) => {
      body += chunk;
    });
    incoming.on('end', () => {
      const token = incoming.headers.authorization?.replace(/^Bearer /u, '') ?? '';
      void verifier.verify(token).then(
        (principal) => {
          taskCalls.push({
            path: incoming.url,
            key: incoming.headers['idempotency-key'],
            body: JSON.parse(body) as unknown,
            principal,
          });
          outgoing.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'private, no-store',
          });
          outgoing.end(JSON.stringify({ disposition: 'applied' }));
        },
        () => {
          outgoing.writeHead(401);
          outgoing.end();
        },
      );
    });
  });
  let app: NestExpressApplication | undefined;
  let signer: InternalTokenSigner;
  let migrator: pg.Pool;

  /**
   * The running application.
   *
   * @returns The application created in `beforeAll`.
   */
  function service(): NestExpressApplication {
    if (app === undefined) {
      throw new Error('The application did not start.');
    }
    return app;
  }

  beforeAll(async () => {
    natsHostPort = await freePort();
    compose(
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      '120',
      'postgres',
      'nats',
      'nats-streams',
    );
    const postgresPort = hostPort('postgres', '5432');

    vi.stubEnv(
      'MIGRATION_DATABASE_URL',
      `postgres://automation_migrator:automation_migrator@127.0.0.1:${postgresPort}/automation`,
    );
    await runMigrator();
    migrator = new pg.Pool({
      connectionString: `postgres://automation_migrator:automation_migrator@127.0.0.1:${postgresPort}/automation`,
      max: 1,
      // Kept open for the whole run, so the stop of PostgreSQL below always reaches it.
      idleTimeoutMillis: 0,
    });
    // The client is terminated (57P01) when a test stops PostgreSQL; the pool reports it as an
    // `error` event, which would otherwise be an uncaught exception.
    migrator.on('error', () => undefined);

    vi.stubEnv('PORT', '3017');
    vi.stubEnv('LOG_PRETTY', 'false');
    vi.stubEnv(
      'DATABASE_URL',
      `postgres://automation_app:automation_app@127.0.0.1:${postgresPort}/automation`,
    );
    vi.stubEnv('NATS_URL', `nats://127.0.0.1:${natsHostPort}`);
    vi.stubEnv('NATS_USER', 'automation');
    vi.stubEnv('NATS_PASSWORD', 'automation');
    vi.stubEnv('INTERNAL_TOKEN_AUDIENCE', 'automation-service');
    verifier = await InternalTokenVerifier.create({
      audience: 'task-service',
      trustedIssuers: { 'automation-service': [automation.publicJwk] },
    });
    await new Promise<void>((resolve) => task.listen(0, '127.0.0.1', resolve));
    const address = task.address();
    if (address === null || typeof address === 'string')
      throw new Error('Task fixture has no port.');
    vi.stubEnv('TASK_SERVICE_URL', `http://127.0.0.1:${String(address.port)}`);
    vi.stubEnv('INTERNAL_TOKEN_PRIVATE_JWK', JSON.stringify(automation.privateJwk));
    vi.stubEnv('AUTOMATION_TASK_TRIGGERS_ENABLED', 'true');
    vi.stubEnv('AUTOMATION_COMMENT_AND_NOTIFICATION_ACTIONS_ENABLED', 'false');
    vi.stubEnv('AUTOMATION_CURSOR_SIGNING_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv(
      'INTERNAL_TOKEN_TRUSTED_ISSUERS',
      JSON.stringify({ 'api-gateway': [gateway.publicJwk] }),
    );

    @Module({
      imports: [AppModule],
      controllers: [WiringProbeController],
      providers: [ShutdownGate],
    })
    class ProbedApplicationModule {}

    // As main.ts: the configuration is read inside the start-up, never when a module is imported.
    const config = loadConfig(appConfigSchema);
    app = await createApplication(ProbedApplicationModule, {
      service: 'automation-service',
      config,
      internalToken: {
        verifier: {
          audience: config.INTERNAL_TOKEN_AUDIENCE,
          trustedIssuers: config.INTERNAL_TOKEN_TRUSTED_ISSUERS,
        },
      },
      logDestination: { write: (): void => undefined },
    });
    await app.init();
    signer = await InternalTokenSigner.create({
      issuer: 'api-gateway',
      privateJwk: gateway.privateJwk,
    });
  });

  afterAll(async () => {
    try {
      releaseShutdown();
      await app?.close();
      if (task.listening) {
        await new Promise<void>((resolve) => {
          task.close(() => {
            resolve();
          });
        });
      }
      await migrator.end();
    } finally {
      vi.unstubAllEnvs();
      compose('down', '--volumes', '--remove-orphans');
    }
  });

  it('applies migrations as the migrator role, which owns the platform and rule tables', async () => {
    const tables = await migrator.query<{ tablename: string; tableowner: string }>(
      `select tablename, tableowner from pg_tables where schemaname = 'public' order by tablename`,
    );
    const journal = await migrator.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    );

    expect(tables.rows).toEqual(
      ['automation_rules', 'automation_runs', 'automation_trigger_budget', ...platformTables].map(
        (tablename) => ({
          tablename,
          tableowner: 'automation_migrator',
        }),
      ),
    );
    expect(journal.rows).toEqual([{ applied: migrationCount }]);
  });

  it('serializes create and re-enable at the same enabled rule capacity', async () => {
    const organizationId = '01938f6e-0000-7000-8000-000000000082';
    const disabledRuleId = '01938f6e-0000-7000-8000-000000000083';
    const system = service().get(SystemTransactionRunner);
    await system.run(async ({ client }) => {
      await client.query(
        `insert into automation_rules (organization_id, id, rule_author_user_id, trigger, action, enabled)
         select $1::uuid, case when n = 100 then $2::uuid else uuidv7() end,
                $3, '{"type":"created"}'::jsonb, '{"type":"priority","priority":"haute"}'::jsonb,
                n < 100
         from generate_series(1, 100) n`,
        [organizationId, disabledRuleId, camilleMartinId],
      );
    });
    const token = await signer.sign('automation-service', {
      actor: { type: 'user', id: camilleMartinId },
      organizationId,
      role: 'owner',
    });
    const [created, enabled] = await Promise.all([
      request(service().getHttpServer())
        .post('/internal/v1/automations')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ trigger: { type: 'created' }, action: { type: 'priority', priority: 'haute' } }),
      request(service().getHttpServer())
        .patch(`/internal/v1/automations/${disabledRuleId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ enabled: true }),
    ]);
    expect([created.status, enabled.status]).toContain(503);
    expect([created, enabled].find((response) => response.status === 503)?.body).toMatchObject({
      code: 'automation.unavailable',
    });
    const enabledRules = await system.run(({ client }) =>
      client.query(
        'select count(*)::int as count from automation_rules where organization_id = $1 and enabled',
        [organizationId],
      ),
    );
    expect(enabledRules.rows).toEqual([{ count: 100 }]);
  });

  it('applies nothing when the migrator runs again', async () => {
    await runMigrator();

    const journal = await migrator.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    );
    expect(journal.rows).toEqual([{ applied: migrationCount }]);
  });

  it('recreates the active-rule lookup index when upgrading an existing table', async () => {
    const indexName = 'automation_rules_enabled_organization_created_id_index';
    await migrator.query(`drop index public.${indexName}`);
    await runMigrator();
    const indexes = await migrator.query(
      'select indisvalid as usable from pg_index where indexrelid = to_regclass($1)',
      [`public.${indexName}`],
    );
    expect(indexes.rows).toEqual([{ usable: true }]);
  });

  it('replays rule creation per actor and authenticates the listing cursor', async () => {
    const rulesOrganizationId = '01938f6e-0000-7000-8000-000000000072';
    const [ownerToken, adminToken] = await Promise.all([
      signer.sign('automation-service', {
        actor: { type: 'user', id: camilleMartinId },
        organizationId: rulesOrganizationId,
        role: 'owner',
      }),
      signer.sign('automation-service', {
        actor: { type: 'user', id: '01938f6e-0000-7000-8000-000000000071' },
        organizationId: rulesOrganizationId,
        role: 'admin',
      }),
    ]);
    const key = randomUUID();
    const create = (token: string) =>
      request(service().getHttpServer())
        .post('/internal/v1/automations')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({ trigger: { type: 'created' }, action: { type: 'priority', priority: 'haute' } });

    const created = await create(ownerToken).expect(201);
    const replay = await create(ownerToken).expect(201);
    const other = await create(adminToken).expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(created.body);
    expect(other.body).not.toEqual(created.body);
    expect(other.headers['idempotent-replayed']).toBeUndefined();

    const list = (cursor?: string) =>
      request(service().getHttpServer())
        .get('/internal/v1/automations')
        .set('Authorization', `Bearer ${ownerToken}`)
        .query({ limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    const first = await list().expect(200);
    const page = first.body as { readonly nextCursor: unknown };
    expect(typeof page.nextCursor).toBe('string');
    if (typeof page.nextCursor !== 'string') throw new Error('Expected an authenticated cursor.');
    await list(page.nextCursor).expect(200);
    const forged = await list(`A${page.nextCursor}`).expect(400);
    expect(forged.body).toMatchObject({ code: 'request.invalid' });
  });

  it('requires current signed recipient proof before replaying a stored rule', async () => {
    const organizationId = '01938f6e-0000-7000-8000-000000000073';
    const recipientId = '01938f6e-0000-7000-8000-000000000074';
    const token = (scopes: readonly string[]) =>
      signer.sign('automation-service', {
        actor: { type: 'user', id: camilleMartinId },
        organizationId,
        role: 'owner',
        scopes,
      });
    const [approved, missing, stale] = await Promise.all([
      token([`automation:recipient:${recipientId}`]),
      token([]),
      token([`automation:recipient:${camilleMartinId}`]),
    ]);
    const key = randomUUID();
    const create = (authorization: string) =>
      request(service().getHttpServer())
        .post('/internal/v1/automations')
        .set('Authorization', `Bearer ${authorization}`)
        .set('Idempotency-Key', key)
        .send({ trigger: { type: 'created' }, action: { type: 'assign', userId: recipientId } });

    const first = await create(approved).expect(201);
    for (const refused of [missing, stale]) {
      const response = await create(refused).expect(422);
      expect(response.body).toMatchObject({ code: 'automation.recipient-ineligible' });
      expect(response.headers['idempotent-replayed']).toBeUndefined();
    }
    const replay = await create(approved).expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
  });

  it('rejects new and reactivated rules for unavailable actions without changing stored rules', async () => {
    const organizationId = '01938f6e-0000-7000-8000-000000000078';
    const recipientId = '01938f6e-0000-7000-8000-000000000079';
    const actions = [
      { type: 'comment', body: 'Ready for review' },
      { type: 'notify', userId: recipientId },
    ];
    const trigger = { type: 'created' };
    const owner = {
      actor: { type: 'user', id: camilleMartinId },
      organizationId,
      role: 'owner',
    } as const;
    const [approved, missing] = await Promise.all([
      signer.sign('automation-service', {
        ...owner,
        scopes: [`automation:recipient:${recipientId}`],
      }),
      signer.sign('automation-service', owner),
    ]);
    const create = (authorization: string, action: (typeof actions)[number]) =>
      request(service().getHttpServer())
        .post('/internal/v1/automations')
        .set('Authorization', `Bearer ${authorization}`)
        .set('Idempotency-Key', randomUUID())
        .send({ trigger, action });
    const denied = await create(missing, { type: 'notify', userId: recipientId }).expect(422);
    expect(denied.body).toMatchObject({ code: 'automation.recipient-ineligible' });
    for (const action of actions) {
      const unavailable = await create(approved, action).expect(503);
      expect(unavailable.body).toMatchObject({ code: 'automation.unavailable' });
      expect(unavailable.headers.location).toBeUndefined();
    }

    const system = service().get(SystemTransactionRunner);
    const counts = await system.run(({ client }) =>
      client.query(
        `select
           (select count(*)::int from automation_rules where organization_id = $1) as rules,
           (select count(*)::int from idempotency_keys where organization_id = $1) as receipts`,
        [organizationId],
      ),
    );
    expect(counts.rows).toEqual([{ rules: 0, receipts: 0 }]);

    for (const action of actions) {
      const result = await system.run(({ client }) =>
        client.query(
          `insert into automation_rules (organization_id, rule_author_user_id, trigger, action)
           values ($1, $2, $3, $4) returning id`,
          [organizationId, camilleMartinId, trigger, action],
        ),
      );
      const row = result.rows[0] as { readonly id: string } | undefined;
      const id = row?.id;
      if (id === undefined) throw new Error('Expected the stored rule ID.');
      const update = (etag: string, body: { enabled: boolean; action?: typeof action }) =>
        request(service().getHttpServer())
          .patch(`/internal/v1/automations/${id}`)
          .set('Authorization', `Bearer ${approved}`)
          .set('If-Match', etag)
          .send(body);
      const disabled = await update('"1"', { enabled: false }).expect(200);
      expect(disabled.body).toMatchObject({ enabled: false, version: 2, action });
      const stale = await update('"1"', { enabled: true }).expect(412);
      expect(stale.body).toMatchObject({ code: 'request.version-mismatch' });
      const unavailable = await update('"2"', { enabled: true }).expect(503);
      expect(unavailable.body).toMatchObject({ code: 'automation.unavailable' });
      const invalid = await update('"2"', { enabled: true, action }).expect(400);
      expect(invalid.body).toMatchObject({ code: 'request.invalid' });
      const unchanged = await update('"2"', { enabled: false }).expect(200);
      expect(unchanged.body).toMatchObject({ enabled: false, version: 2, action });
    }
  });

  it('forces row-level security on the tables that carry an organization', async () => {
    const tables = await migrator.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity
         from pg_class
        where relnamespace = 'public'::regnamespace and relkind = 'r'
        order by relname`,
    );
    const policies = await migrator.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies where schemaname = 'public' order by tablename`,
    );

    expect(tables.rows).toEqual([
      { relname: 'automation_rules', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'automation_runs', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'automation_trigger_budget', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'event_versions', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'idempotency_keys', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'outbox_events', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'processed_events', relrowsecurity: false, relforcerowsecurity: false },
    ]);
    expect(policies.rows).toEqual([
      { tablename: 'automation_rules', policyname: 'automation_rules_tenant_isolation' },
      { tablename: 'automation_runs', policyname: 'automation_runs_tenant_isolation' },
      {
        tablename: 'automation_trigger_budget',
        policyname: 'automation_trigger_budget_tenant_isolation',
      },
      { tablename: 'event_versions', policyname: 'event_versions_organization_isolation' },
      { tablename: 'idempotency_keys', policyname: 'idempotency_keys_organization_isolation' },
      { tablename: 'outbox_events', policyname: 'outbox_events_organization_isolation' },
    ]);
  });

  it('purges expired receipts with the system worker and leaves an unexpired sibling receipt', async () => {
    const system = service().get(SystemTransactionRunner);
    const queue = AUTOMATION_PURGE_RECEIPTS_QUEUE.name;
    const producer = service().get(JobProducer);
    const receipts = [
      { key: randomUUID(), expiresAfterHours: -1 },
      { key: randomUUID(), expiresAfterHours: 1 },
    ];
    const liveKey = receipts.find((receipt) => receipt.expiresAfterHours > 0)?.key;
    await system.run(async (scope) => {
      for (const receipt of receipts) {
        await scope.client.query(
          `insert into idempotency_keys
            (organization_id, key, request_fingerprint, response_status, response_headers, expires_at)
           values ($1, $2, 'fixture', 201, '{}'::jsonb, statement_timestamp() + $3 * interval '1 hour')`,
          [atelierNordId, receipt.key, receipt.expiresAfterHours],
        );
      }
      await producer.enqueue(scope, queue, null);
    });
    try {
      await vi.waitFor(
        async () => {
          const found = await system.run(({ client }) =>
            client.query('select key from idempotency_keys where key = any($1::text[])', [
              receipts.map(({ key }) => key),
            ]),
          );
          expect(found.rows).toEqual([{ key: liveKey }]);
        },
        { timeout: 10_000 },
      );
    } finally {
      await system.run(({ client }) =>
        client.query('delete from idempotency_keys where key = any($1::text[])', [
          receipts.map(({ key }) => key),
        ]),
      );
    }
  });

  it('answers the liveness probe without a token', async () => {
    const response = await request(service().getHttpServer()).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok' });
  });

  it('is ready once PostgreSQL answers the application role and NATS the automation user', async () => {
    const response = await request(service().getHttpServer()).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      details: { postgres: { status: 'up' }, nats: { status: 'up' } },
    });
  });

  it('refuses a route of the application without an internal token', async () => {
    const response = await request(service().getHttpServer()).get('/internal/v1/wiring-probe');

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/u);
    expect(response.body).toMatchObject({ status: 401, code: 'auth.token-missing' });
  });

  it('serves a route to a trusted issuer acting for a member of the organization', async () => {
    const token = await signer.sign('automation-service', {
      actor: { type: 'user', id: camilleMartinId },
      organizationId: atelierNordId,
    });

    const response = await request(service().getHttpServer())
      .get('/internal/v1/wiring-probe')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ reached: true });
  });

  it('refuses a token signed for another service', async () => {
    const token = await signer.sign('document-service', {
      actor: { type: 'user', id: camilleMartinId },
      organizationId: atelierNordId,
    });

    const response = await request(service().getHttpServer())
      .get('/internal/v1/wiring-probe')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: 'auth.token-invalid',
      details: { reason: 'audience' },
    });
  });

  it('lets the application role read and write the platform tables of its organization only', async () => {
    const tenant = service().get(TenantTransactionRunner);
    const countAll = async (organizationId: string): Promise<Record<string, number>> =>
      runWithOrganizationContext(memberOf(organizationId), () =>
        tenant.run(async (tx) => {
          const counts = await tx.client.query(
            `select 'outbox_events' as name, count(*)::int as rows from outbox_events
             union all select 'event_versions', count(*)::int from event_versions
             union all select 'idempotency_keys', count(*)::int from idempotency_keys`,
          );
          const rows = counts.rows as readonly { readonly name: string; readonly rows: number }[];
          return Object.fromEntries(rows.map(({ name, rows: count }) => [name, count]));
        }),
      );

    // Sent rather than pending: the relay must have nothing to publish.
    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (tx) => {
        await tx.client.query(
          `insert into outbox_events
             (id, event_name, subject, stream, organization_id, payload, status, sent_at)
           values (uuidv7(), 'automation.wiring-probe.v1', 'evt.automation.wiring-probe.v1',
                   'EVENTS', $1, '{}', 'sent', now())`,
          [atelierNordId],
        );
        await tx.client.query(
          `insert into event_versions (consumer, organization_id, aggregate_key, version)
           values ('automation-service__wiring-probe', $1, 'task:CAD-482', 1)`,
          [atelierNordId],
        );
        await tx.client.query(
          `update event_versions set version = 2 where aggregate_key = 'task:CAD-482'`,
        );
        await tx.client.query(
          `insert into idempotency_keys
             (organization_id, key, request_fingerprint, response_status, response_headers,
              expires_at)
           values ($1, 'wiring-probe', 'fingerprint', 201, '{}', now() + interval '1 day')`,
          [atelierNordId],
        );
        await tx.client.query(
          `insert into processed_events (consumer, event_id)
           values ('automation-service__wiring-probe', uuidv7())`,
        );
      }),
    );

    expect(await countAll(atelierNordId)).toEqual({
      outbox_events: 1,
      event_versions: 1,
      idempotency_keys: 1,
    });
    expect(await countAll(otherOrganizationId)).toEqual({
      outbox_events: 0,
      event_versions: 0,
      idempotency_keys: 0,
    });
    await expect(
      runWithOrganizationContext(memberOf(otherOrganizationId), () =>
        tenant.run((tx) =>
          tx.client.query(
            `insert into event_versions (consumer, organization_id, aggregate_key, version)
             values ('automation-service__wiring-probe', $1, 'task:CAD-483', 1)`,
            [atelierNordId],
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const deleted = await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (tx) => {
        const counts: number[] = [];
        for (const table of platformTables) {
          counts.push((await tx.client.query(`delete from ${table} returning 1`)).rows.length);
        }
        return counts;
      }),
    );
    expect(deleted).toEqual([1, 1, 1, 1]);
  });

  it('refuses any change of structure to the application role', async () => {
    const system = service().get(SystemTransactionRunner);
    const statements = [
      'create table wiring_probe (id integer)',
      'alter table outbox_events add column wiring_probe integer',
      'alter table outbox_events no force row level security',
      'drop table processed_events',
      'truncate idempotency_keys',
      'create schema wiring_probe',
    ];

    for (const statement of statements) {
      await expect(system.run((tx) => tx.client.query(statement))).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('keeps the application role out of the journal of the migrations', async () => {
    const system = service().get(SystemTransactionRunner);

    // A rewritten journal would make the next migration run apply migrations again.
    await expect(
      system.run((tx) => tx.client.query('delete from drizzle.__drizzle_migrations')),
    ).rejects.toMatchObject({ code: '42501', message: 'permission denied for schema drizzle' });
    const journal = await migrator.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    );
    expect(journal.rows).toEqual([{ applied: migrationCount }]);
  });

  it('records one execution without paging through nonmatching rules after a JetStream event', async () => {
    const organizationId = '01938f6e-0000-7000-8000-000000000075';
    const ownerToken = await signer.sign('automation-service', {
      actor: { type: 'user', id: camilleMartinId },
      organizationId,
      role: 'owner',
    });
    const created = await request(service().getHttpServer())
      .post('/internal/v1/automations')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ trigger: { type: 'created' }, action: { type: 'priority', priority: 'haute' } })
      .expect(201);
    const { ruleId } = created.body as { readonly ruleId: string };
    const system = service().get(SystemTransactionRunner);
    await system.run(({ client }) =>
      client.query(
        `insert into automation_rules (organization_id, rule_author_user_id, trigger, action, enabled, created_at)
         select $1, $2,
                case when n % 2 = 0 then '{"type":"status","status":"progress"}'::jsonb
                     else '{"type":"created"}'::jsonb end,
                '{"type":"priority","priority":"haute"}',
                n % 2 = 0,
                now() - interval '1 hour'
           from generate_series(1, 40) as series(n)`,
        [organizationId, camilleMartinId],
      ),
    );
    await system.run(({ client }) =>
      client.query(
        `insert into automation_rules (organization_id, rule_author_user_id, trigger, action)
         values ($1, $2, '{"type":"created"}', $3), ($1, $2, '{"type":"created"}', $4)`,
        [
          organizationId,
          camilleMartinId,
          { type: 'comment', body: 'Ready for review' },
          { type: 'notify', userId: camilleMartinId },
        ],
      ),
    );
    const event = taskCreatedV1Schema.parse({
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      organizationId,
      actor: { type: 'user', id: camilleMartinId },
      version: 1,
      key: 'CAD-482',
      spaceId: '01938f6e-0000-7000-8000-000000000076',
      listId: '01938f6e-0000-7000-8000-000000000077',
      parentKey: null,
      name: 'Refondre l’écran de connexion SSO',
      status: 'progress',
      cancelReason: null,
      priority: 'moyenne',
      assigneeIds: [],
      dueDate: null,
      startDate: null,
      estimateMinutes: null,
      labels: [],
      completedAt: null,
    });
    const publish = (payload: unknown) =>
      compose(
        'exec',
        '-T',
        'nats-streams',
        'nats',
        'pub',
        'evt.task.created.v1',
        JSON.stringify(payload),
      );
    publish(event);
    await vi.waitFor(
      async () => {
        const runs = await system.run(({ client }) =>
          client.query(
            `select id, status from automation_runs
              where organization_id = $1 and rule_id = $2 and source_event_id = $3`,
            [organizationId, ruleId, event.id],
          ),
        );
        expect(runs.rows).toHaveLength(1);
        const row = runs.rows[0] as { readonly id: string; readonly status: string };
        expect(row.status).toBe('applied');
        expect(taskCalls).toHaveLength(1);
        expect(taskCalls[0]).toMatchObject({
          path: '/internal/v1/tasks/CAD-482/automation-actions',
          key: row.id,
          body: { type: 'priority', priority: 'haute', ruleAuthorUserId: camilleMartinId },
          principal: {
            issuer: 'automation-service',
            audience: 'task-service',
            organizationId,
            actor: { type: 'automation', id: ruleId },
          },
        });
        const outbox = await system.run(({ client }) =>
          client.query(
            `select event_name from outbox_events
              where organization_id = $1 and event_name = 'automation.executed.v1'`,
            [organizationId],
          ),
        );
        expect(outbox.rows).toEqual([{ event_name: 'automation.executed.v1' }]);
      },
      { timeout: 30_000, interval: 100 },
    );
    publish(event);
    const loopEvent = { ...event, id: randomUUID(), actor: { type: 'automation', id: ruleId } };
    publish(loopEvent);
    await vi.waitFor(
      async () => {
        const receipts = await system.run(({ client }) =>
          client.query(
            `select event_id from processed_events
              where consumer = 'automation-service__run-task-created-rules'
                and event_id = any($1::uuid[])`,
            [[event.id, loopEvent.id]],
          ),
        );
        expect(receipts.rows).toHaveLength(2);
      },
      { timeout: 15_000, interval: 100 },
    );
    const history = await request(service().getHttpServer())
      .get('/internal/v1/automation-runs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(history.body).toMatchObject({
      items: [{ ruleId, taskKey: 'CAD-482', action: { type: 'priority', priority: 'haute' } }],
      nextCursor: null,
    });
    expect((history.body as { readonly items: readonly unknown[] }).items).toHaveLength(1);
    const [runs, outbox, jobs] = await Promise.all([
      system.run(({ client }) =>
        client.query('select id from automation_runs where organization_id = $1', [organizationId]),
      ),
      system.run(({ client }) =>
        client.query(
          `select id from outbox_events where organization_id = $1
            and event_name = 'automation.executed.v1'`,
          [organizationId],
        ),
      ),
      system.run(({ client }) =>
        client.query(
          `select name, data #>> '{payload,kind}' as kind, data #>> '{payload,ruleId}' as rule_id
             from pgboss.job
            where data #>> '{payload,source,id}' = $1 and data ->> 'organizationId' = $2
            order by kind`,
          [event.id, organizationId],
        ),
      ),
    ]);
    expect(runs.rows).toHaveLength(1);
    expect(outbox.rows).toHaveLength(1);
    expect(jobs.rows).toEqual([
      { name: AUTOMATION_TASK_TRIGGER_QUEUE.name, kind: 'action', rule_id: ruleId },
      { name: AUTOMATION_TASK_TRIGGER_QUEUE.name, kind: 'page', rule_id: null },
    ]);
    expect(taskCalls).toHaveLength(1);
  });

  it('publishes a pending event through the outbox relay', async () => {
    const system = service().get(SystemTransactionRunner);
    const eventId = '01938f6e-0000-7000-8000-000000000011';
    await system.run(({ client }) =>
      client.query(
        `insert into outbox_events (id, event_name, subject, stream, payload)
         values ($1, 'automation.wiring-probe.v1', 'evt.automation.wiring-probe.v1', 'EVENTS',
                 jsonb_build_object('id', $1::uuid, 'organizationId', null, 'occurredAt', now()))`,
        [eventId],
      ),
    );
    try {
      await vi.waitFor(
        async () => {
          const sent = await system.run(({ client }) =>
            client.query('select status from outbox_events where id = $1', [eventId]),
          );
          expect(sent.rows).toEqual([{ status: 'sent' }]);
        },
        { timeout: 10_000, interval: 100 },
      );
      expect((await request(service().getHttpServer()).get('/health/ready')).status).toBe(200);
    } finally {
      await system.run(({ client }) =>
        client.query('delete from outbox_events where id = $1', [eventId]),
      );
    }
  });

  it('runs against a broker that enforces the permissions of cadenway-ops', () => {
    const automation = { NATS_USER: 'automation', NATS_PASSWORD: 'automation' };

    expect(
      brokerAccepts(automation, '--inbox-prefix', '_INBOX.automation', 'stream', 'info', 'EVENTS'),
    ).toBe(true);
    expect(brokerAccepts(automation, 'stream', 'info', 'EVENTS')).toBe(false);
    expect(brokerAccepts(automation, 'pub', 'evt.task.wiring-probe', 'refused')).toBe(false);
    expect(
      brokerAccepts({ NATS_USER: '', NATS_PASSWORD: '' }, 'pub', 'evt.automation.x', 'x'),
    ).toBe(false);
  });

  it('stops being ready while NATS is down, and is ready again once it is back', async () => {
    compose('stop', 'nats');

    await vi.waitFor(
      async () => {
        const response = await request(service().getHttpServer()).get('/health/ready');
        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
          status: 'error',
          info: { postgres: { status: 'up' } },
          error: { nats: { status: 'down' } },
        });
      },
      { timeout: 10_000, interval: 250 },
    );

    compose('start', 'nats');

    await vi.waitFor(
      async () => {
        const response = await request(service().getHttpServer()).get('/health/ready');
        expect(response.status).toBe(200);
      },
      { timeout: 30_000, interval: 500 },
    );
  });

  it('stops being ready when its database is down', async () => {
    compose('stop', 'postgres');

    const response = await request(service().getHttpServer()).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'error',
      error: { postgres: { status: 'down' } },
    });
  });

  it('answers 503 on readiness and 200 on liveness as soon as it shuts down', async () => {
    const running = service();
    const closing = running.close();

    await vi.waitFor(
      async () => {
        const response = await request(running.getHttpServer()).get('/health/ready');
        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
          error: { shutdown: { status: 'down', message: 'shutting down' } },
        });
      },
      { timeout: 5_000, interval: 50 },
    );
    const live = await request(running.getHttpServer()).get('/health/live');
    expect(live.status).toBe(200);

    releaseShutdown();
    await closing;
    app = undefined;
  });
});
