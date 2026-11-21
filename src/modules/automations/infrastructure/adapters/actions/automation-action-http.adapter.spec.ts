import {
  InternalHttpClient,
  InternalTokenSigner,
  InternalTokenVerifier,
  ProblemException,
  runWithOrganizationContext,
} from '@cadenway/nest-common';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AutomationRun } from '../../../application/models/runs/automation-run.model.js';
import { AutomationActionHttpAdapter } from './automation-action-http.adapter.js';

const organizationId = '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const ruleId = '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e02';
const ruleAuthorUserId = '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e03';
const recipientId = '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e04';
const runId = '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e05';
const fixtureTime = new Date('2026-11-21T12:00:00.000Z');

const reservedRun: AutomationRun = {
  organizationId,
  id: runId,
  ruleId,
  taskKey: 'CAD-482',
  ruleAuthorUserId,
  sourceEventId: '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e06',
  action: { type: 'priority', priority: 'haute' },
  status: 'pending',
  createdAt: fixtureTime,
  updatedAt: fixtureTime,
  executedAt: null,
};

interface TaskRequest {
  // #region Properties
  /** Request metadata and original body as received by the Task fixture. */
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  // #endregion
}

interface TaskResponse {
  // #region Properties
  /** Status, headers and body the Task fixture sends. */
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  // #endregion
}

const applied: TaskResponse = {
  status: 200,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
  },
  body: JSON.stringify({ disposition: 'applied' }),
};

function problem(status: number, code: string): TaskResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
    body: JSON.stringify({ type: 'about:blank', title: 'Task command refused', status, code }),
  };
}

async function withActionServer(
  signer: InternalTokenSigner,
  reply: (attempt: number) => TaskResponse,
  verify: (adapter: AutomationActionHttpAdapter, calls: readonly TaskRequest[]) => Promise<void>,
  extraActions = false,
): Promise<void> {
  const calls: TaskRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      calls.push({ method: request.method, path: request.url, headers: request.headers, body });
      const result = reply(calls.length);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    });
  });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Task test server did not bind.');
    const baseUrl = `http://127.0.0.1:${String(address.port)}`;
    const task = new InternalHttpClient({
      service: 'task-service',
      baseUrl,
      allowedUnavailableProblemCodes: ['task.action-unavailable'],
      signer,
    });
    const notification = extraActions
      ? new InternalHttpClient({
          service: 'notification-service',
          baseUrl,
          allowedUnavailableProblemCodes: ['upstream.unavailable'],
          signer,
        })
      : undefined;
    await verify(new AutomationActionHttpAdapter(task, notification), calls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

describe('AutomationActionHttpAdapter', () => {
  let signer: InternalTokenSigner;
  let verifier: InternalTokenVerifier;
  let notificationVerifier: InternalTokenVerifier;

  beforeAll(async () => {
    const issuer = 'automation-service';
    const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    if (x === undefined || d === undefined) throw new Error('Could not generate a test key.');
    const publicJwk = { kid: 'automation-task-test', kty: 'OKP', crv: 'Ed25519', x } as const;
    signer = await InternalTokenSigner.create({ issuer, privateJwk: { ...publicJwk, d } });
    verifier = await InternalTokenVerifier.create({
      audience: 'task-service',
      trustedIssuers: { [issuer]: [publicJwk] },
    });
    notificationVerifier = await InternalTokenVerifier.create({
      audience: 'notification-service',
      trustedIssuers: { [issuer]: [publicJwk] },
    });
  });

  it('signs a generated priority request as its tenant and rule using the reserved command key', async () => {
    await withActionServer(
      signer,
      () => applied,
      async (adapter, calls) => {
        const result = await runWithOrganizationContext(
          {
            organizationId: '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e07',
            actor: { type: 'user', id: ruleAuthorUserId },
            role: 'admin',
            scopes: ['tasks:write'],
          },
          () => adapter.execute(reservedRun),
        );
        expect(result).toBe('applied');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          method: 'POST',
          path: '/internal/v1/tasks/CAD-482/automation-actions',
          headers: { 'content-type': 'application/json', 'idempotency-key': runId },
        });
        expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
          ruleAuthorUserId,
          type: 'priority',
          priority: 'haute',
        });
        const token = calls[0]?.headers.authorization?.replace(/^Bearer /u, '') ?? '';
        await expect(verifier.verify(token)).resolves.toMatchObject({
          issuer: 'automation-service',
          audience: 'task-service',
          organizationId,
          actor: { type: 'automation', id: ruleId },
          role: null,
          scopes: [],
        });
      },
    );
  });

  it('passes the assignment recipient separately from the author and preserves a replayed no-op', async () => {
    const response = {
      ...applied,
      headers: { ...applied.headers, 'Idempotent-Replayed': 'true' },
      body: JSON.stringify({ disposition: 'no_op' }),
    };
    const assignment: AutomationRun = {
      ...reservedRun,
      action: { type: 'assign', userId: recipientId },
    };
    await withActionServer(
      signer,
      () => response,
      async (adapter, calls) => {
        await expect(adapter.execute(assignment)).resolves.toBe('no_op');
        expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
          ruleAuthorUserId,
          type: 'assign',
          userId: recipientId,
        });
      },
    );
  });

  it('keeps the signed command body and idempotency key stable across a temporary Task outage', async () => {
    await withActionServer(
      signer,
      (attempt) => (attempt <= 2 ? problem(503, 'task.action-unavailable') : applied),
      async (adapter, calls) => {
        await expect(adapter.execute(reservedRun)).rejects.toMatchObject({
          problem: { status: 503, code: 'task.action-unavailable' },
        });
        await expect(adapter.execute(reservedRun)).resolves.toBe('applied');
        expect(calls.map((call) => call.headers['idempotency-key'])).toEqual([runId, runId, runId]);
        expect(new Set(calls.map((call) => call.body)).size).toBe(1);
      },
    );
  });

  it.each([
    { status: 404, code: 'task.not-found' },
    { status: 422, code: 'task.assignee-invalid' },
  ])('preserves $code as a refusal instead of completing a no-op', async ({ status, code }) => {
    await withActionServer(
      signer,
      () => problem(status, code),
      async (adapter, calls) => {
        await expect(adapter.execute(reservedRun)).rejects.toMatchObject({
          problem: { status, code },
        });
        expect(calls).toHaveLength(1);
      },
    );
  });

  it.each([
    {
      name: 'cacheable',
      response: { ...applied, headers: { 'Content-Type': 'application/json' } },
    },
    { name: 'unexpected', response: { ...applied, body: '{"disposition":"ignored"}' } },
    {
      name: 'overexposed',
      response: { ...applied, body: '{"disposition":"applied","title":"task"}' },
    },
    { name: 'malformed', response: { ...applied, body: '{' } },
  ])('refuses to settle from a $name Task receipt', async ({ response }) => {
    await withActionServer(
      signer,
      () => response,
      async (adapter) => {
        await expect(adapter.execute(reservedRun)).rejects.toThrow();
      },
    );
  });

  it('makes no call for a disabled, invalid or already cancelled action', async () => {
    await withActionServer(
      signer,
      () => applied,
      async (adapter, calls) => {
        for (const action of [
          { type: 'comment', body: 'Un passage en revue est nécessaire.' },
          { type: 'notify', userId: recipientId },
          { type: 'priority', priority: 'invalid-priority' },
        ] as const) {
          await expect(adapter.execute({ ...reservedRun, action })).rejects.toThrow();
        }
        const controller = new AbortController();
        const reason = new Error('Job is no longer active.');
        controller.abort(reason);
        await expect(adapter.execute(reservedRun, controller.signal)).rejects.toBe(reason);
        expect(calls).toEqual([]);
      },
    );
  });

  it('dispatches a private comment receipt to Task with a canonical signed rule and no extra fields', async () => {
    const body = 'Un passage en revue est nécessaire.';
    await withActionServer(
      signer,
      () => applied,
      async (adapter, calls) => {
        await expect(
          adapter.execute({
            ...reservedRun,
            ruleId: ruleId.toUpperCase(),
            action: { type: 'comment', body },
          }),
        ).resolves.toBe('applied');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          method: 'POST',
          path: '/internal/v1/tasks/CAD-482/automation-comments',
          headers: { 'content-type': 'application/json', 'idempotency-key': runId },
        });
        expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ ruleAuthorUserId, body });
        const token = calls[0]?.headers.authorization?.replace(/^Bearer /u, '') ?? '';
        await expect(verifier.verify(token)).resolves.toMatchObject({
          audience: 'task-service',
          organizationId,
          actor: { type: 'automation', id: ruleId },
        });
      },
      true,
    );
  });

  it('uses a stable occurrence across Notification retries and preserves a suppressed notice', async () => {
    const suppressed = { ...applied, body: '{"disposition":"no_op"}' };
    await withActionServer(
      signer,
      (attempt) => (attempt <= 2 ? problem(503, 'upstream.unavailable') : suppressed),
      async (adapter, calls) => {
        const run: AutomationRun = {
          ...reservedRun,
          ruleId: ruleId.toUpperCase(),
          action: { type: 'notify', userId: recipientId },
        };
        await expect(adapter.execute(run)).rejects.toMatchObject({
          problem: { status: 503, code: 'upstream.unavailable' },
        });
        await expect(adapter.execute(run)).resolves.toBe('no_op');
        expect(calls).toHaveLength(3);
        for (const call of calls) {
          expect(call).toMatchObject({
            method: 'POST',
            path: '/internal/v1/inbox/automation-notifications',
            headers: { 'content-type': 'application/json', 'idempotency-key': runId },
          });
          expect(JSON.parse(call.body)).toEqual({
            taskKey: 'CAD-482',
            ruleAuthorUserId,
            recipientUserId: recipientId,
          });
          const token = call.headers.authorization?.replace(/^Bearer /u, '') ?? '';
          await expect(notificationVerifier.verify(token)).resolves.toMatchObject({
            audience: 'notification-service',
            organizationId,
            actor: { type: 'automation', id: ruleId },
          });
        }
      },
      true,
    );
  });

  it('preserves a downstream refusal while stripping its private contents', async () => {
    const response = problem(404, 'notification.not-found');
    const leaked = {
      ...response,
      body: JSON.stringify({
        status: 404,
        code: 'notification.not-found',
        title: recipientId,
        detail: ruleAuthorUserId,
        details: { recipientUserId: recipientId },
      }),
    };
    await withActionServer(
      signer,
      () => leaked,
      async (adapter) => {
        const run: AutomationRun = {
          ...reservedRun,
          action: { type: 'notify', userId: recipientId },
        };
        const error = await adapter.execute(run).catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(ProblemException);
        expect(error).toMatchObject({ problem: { status: 404, code: 'notification.not-found' } });
        expect(error).toHaveProperty('cause', undefined);
        expect(JSON.stringify(error)).not.toContain(recipientId);
      },
      true,
    );
  });

  it('rejects a no-op for a comment because Task can only return applied', async () => {
    await withActionServer(
      signer,
      () => ({ ...applied, body: '{"disposition":"no_op"}' }),
      async (adapter) => {
        const run: AutomationRun = {
          ...reservedRun,
          action: { type: 'comment', body: 'Commentaire valide.' },
        };
        await expect(adapter.execute(run)).rejects.toThrow('could not be confirmed');
      },
      true,
    );
  });
});
