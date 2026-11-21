import { encodeCursor, ProblemException, ZodValidationPipe } from '@cadenway/nest-common';
import {
  CreateAutomationRuleInternalBody,
  ListAutomationRulesInternalQueryParams,
} from '@cadenway/contracts/validators/internal/automation-service';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { CreateAutomationRule } from '../../../../application/use-cases/commands/rules/create-automation-rule/create-automation-rule.use-case.js';
import type { ListAutomationRunCandidates } from '../../../../application/use-cases/queries/runs/list-automation-run-candidates/list-automation-run-candidates.use-case.js';
import type { DeleteAutomationRule } from '../../../../application/use-cases/commands/rules/delete-automation-rule/delete-automation-rule.use-case.js';
import type { SetAutomationRuleEnabled } from '../../../../application/use-cases/commands/rules/set-automation-rule-enabled/set-automation-rule-enabled.use-case.js';
import type { ListAutomationRules } from '../../../../application/use-cases/queries/rules/list-automation-rules/list-automation-rules.use-case.js';
import {
  encodeRuleCursor,
  encodeRunCursor,
  ruleCursor,
  runCursor,
} from '../../mappers/automations/automation-cursor.mapper.js';
import { AutomationRunsController } from './automation-runs.controller.js';
import { AutomationsController } from './automations.controller.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const actorId = '019a5f3c-a0b1-7c2d-9e3f-5a6b7c8d9e32';
const ruleId = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const cursorAuth = { sign: (value: string) => value, authenticate: () => undefined };
const caller = { organizationId, actorId, operation: 'list-automation-rules' };
const request = {
  headers: {},
  internalPrincipal: {
    issuer: 'api-gateway',
    actor: { type: 'user', id: actorId },
    organizationId,
  },
} as unknown as Request;
const setHeader = vi.fn();
const response = { setHeader } as unknown as Response;

describe('automation HTTP boundaries', () => {
  it('binds cursors to the account, organization and operation', () => {
    const position = { createdAt: new Date('2026-11-20T08:05:00.000Z'), ruleId };
    const encoded = encodeRuleCursor(position, caller);
    expect(ruleCursor(encoded, caller)).toEqual(position);
    expect(() => ruleCursor(encoded, { ...caller, actorId: ruleId })).toThrow(ProblemException);
    expect(() => ruleCursor(encoded, { ...caller, organizationId: ruleId })).toThrow(
      ProblemException,
    );
    expect(() => ruleCursor(encoded, { ...caller, operation: 'other' })).toThrow(ProblemException);
  });

  it('preserves the fixed history window and rejects invalid continuation positions', () => {
    const scope = { ...caller, operation: 'list-automation-runs' };
    const upper = { executedAt: new Date('2026-11-20T08:05:00.000Z'), id: ruleId };
    const after = { executedAt: new Date('2026-11-20T08:00:00.000Z'), id: ruleId };
    expect(runCursor(encodeRunCursor(upper, after, 90, scope), scope, 10)).toEqual({
      upper,
      after,
      remaining: 90,
      limit: 10,
    });
    const reversed = encodeRunCursor(after, upper, 90, scope);
    expect(() => runCursor(reversed, scope, 10)).toThrow(ProblemException);
    const excess = encodeCursor(
      {
        sort: [upper.executedAt.toISOString(), upper.id, after.executedAt.toISOString(), 100],
        id: after.id,
      },
      scope,
    );
    expect(() => runCursor(excess, scope, 10)).toThrow(ProblemException);
  });

  it('rejects unknown creation fields and malformed pagination before a use case runs', () => {
    const body = new ZodValidationPipe(CreateAutomationRuleInternalBody);
    const query = new ZodValidationPipe(ListAutomationRulesInternalQueryParams.strict());
    expect(() =>
      body.transform(
        {
          trigger: { type: 'created' },
          action: { type: 'priority', priority: 'haute' },
          organizationId,
        },
        { type: 'body' },
      ),
    ).toThrow(ProblemException);
    expect(() => query.transform({ limit: '101' }, { type: 'query' })).toThrow(ProblemException);
    expect(() => query.transform({ extra: 'value' }, { type: 'query' })).toThrow(ProblemException);
  });

  it('creates with the verified author and omits tenant and author from the response', async () => {
    const state = {
      organizationId,
      ruleAuthorUserId: actorId,
      ruleId,
      trigger: { type: 'created' as const },
      action: { type: 'priority' as const, priority: 'haute' as const },
      enabled: true,
      version: 1,
      createdAt: new Date('2026-11-20T08:05:00.000Z'),
    };
    const execute = vi.fn().mockResolvedValue({ status: 'created', rule: state });
    const controller = new AutomationsController(
      {} as ListAutomationRules,
      { execute } as unknown as CreateAutomationRule,
      {} as SetAutomationRuleEnabled,
      {} as DeleteAutomationRule,
      cursorAuth,
    );
    const result = await controller.create(request, response, {
      trigger: state.trigger,
      action: state.action,
    });
    expect(execute).toHaveBeenCalledWith({
      organizationId,
      ruleAuthorUserId: actorId,
      trigger: state.trigger,
      action: state.action,
    });
    expect(result).toEqual({
      ruleId,
      trigger: state.trigger,
      action: state.action,
      enabled: true,
      version: 1,
      createdAt: '2026-11-20T08:05:00.000Z',
    });
    expect(setHeader).toHaveBeenCalledWith('ETag', '"1"');
  });

  it('maps a stale write to 412 with the current version', async () => {
    const controller = new AutomationsController(
      {} as ListAutomationRules,
      {} as CreateAutomationRule,
      {
        execute: vi.fn().mockResolvedValue({ status: 'version-mismatch', version: 3 }),
      } as unknown as SetAutomationRuleEnabled,
      {} as DeleteAutomationRule,
      cursorAuth,
    );
    await expect(
      controller.update(request, response, { ruleId }, '"2"', { enabled: false }),
    ).rejects.toMatchObject({
      problem: { status: 412, code: 'request.version-mismatch', details: { version: 3 } },
    });
  });

  it('removes comment text and private identities from the execution history', async () => {
    const list = vi.fn().mockResolvedValue({
      items: [
        {
          id: ruleId,
          ruleId,
          taskKey: 'CAD-482',
          action: { type: 'comment', body: 'Private comment text' },
          organizationId,
          ruleAuthorUserId: actorId,
          sourceEventId: ruleId,
          executedAt: new Date('2026-11-20T08:05:00.000Z'),
        },
      ],
      upper: null,
      next: null,
      remaining: 0,
    });
    const controller = new AutomationRunsController(
      { execute: list } as unknown as ListAutomationRunCandidates,
      cursorAuth,
    );
    await expect(controller.list(request, { limit: 50 })).resolves.toEqual({
      items: [
        {
          executionId: ruleId,
          ruleId,
          taskKey: 'CAD-482',
          action: { type: 'comment' },
          executedAt: '2026-11-20T08:05:00.000Z',
        },
      ],
      nextCursor: null,
    });
    expect(list).toHaveBeenCalledWith(organizationId, {
      upper: null,
      after: null,
      remaining: 100,
      limit: 50,
    });
  });

  it('rejects an unauthenticated history cursor before opening a page', async () => {
    const execute = vi.fn();
    const controller = new AutomationRunsController(
      { execute } as unknown as ListAutomationRunCandidates,
      cursorAuth,
    );
    await expect(controller.list(request, { cursor: 'tampered', limit: 50 })).rejects.toMatchObject(
      {
        problem: { status: 400, code: 'request.invalid' },
      },
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
