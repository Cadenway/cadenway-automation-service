import { ProblemException } from '@cadenway/nest-common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AutomationRecipientGuard } from './automation-recipient.guard.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const actorId = '019a5f3c-a0b1-7c2d-9e3f-5a6b7c8d9e32';
const userId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01';

function context(
  body: unknown,
  scopes: readonly string[],
  issuer = 'api-gateway',
): ExecutionContext {
  const request = {
    body,
    internalPrincipal: {
      issuer,
      actor: { type: 'user', id: actorId },
      organizationId,
      scopes,
    },
  };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('AutomationRecipientGuard', () => {
  const guard = new AutomationRecipientGuard();

  it.each(['assign', 'notify'] as const)(
    'requires current matching proof for a %s action, including a replay',
    (type) => {
      const body = { trigger: { type: 'created' }, action: { type, userId } };
      expect(guard.canActivate(context(body, [`automation:recipient:${userId}`]))).toBe(true);
      expectRefusal(
        () => guard.canActivate(context(body, [])),
        422,
        'automation.recipient-ineligible',
      );
      expectRefusal(
        () => guard.canActivate(context(body, [`automation:recipient:${actorId}`])),
        422,
        'automation.recipient-ineligible',
      );
    },
  );

  it('canonicalizes a valid recipient when comparing the signed scope', () => {
    const body = {
      trigger: { type: 'created' },
      action: { type: 'assign', userId: userId.toUpperCase() },
    };
    expect(guard.canActivate(context(body, [`automation:recipient:${userId}`]))).toBe(true);
  });

  it('validates the published body before checking recipient proof', () => {
    const body = {
      trigger: { type: 'created' },
      action: { type: 'assign', userId: 'invalid' },
    };
    expectRefusal(() => guard.canActivate(context(body, [])), 400, 'request.invalid');
  });

  it('rejects proof from a caller other than the gateway', () => {
    const body = { trigger: { type: 'created' }, action: { type: 'assign', userId } };
    expectRefusal(
      () => guard.canActivate(context(body, [`automation:recipient:${userId}`], 'other-service')),
      401,
      'auth.token-invalid',
    );
  });

  it('allows actions without a recipient when the caller is authenticated', () => {
    const body = {
      trigger: { type: 'created' },
      action: { type: 'priority', priority: 'haute' },
    };
    expect(guard.canActivate(context(body, []))).toBe(true);
  });
});

function expectRefusal(run: () => boolean, status: number, code: string): void {
  try {
    run();
    throw new Error('Expected the guard to refuse the request.');
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemException);
    if (!(error instanceof ProblemException)) throw error;
    expect(error.problem).toMatchObject({ status, code });
  }
}
