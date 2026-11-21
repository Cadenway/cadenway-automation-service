import { InternalAccess, ZodValidationPipe } from '@cadenway/nest-common';
import {
  ListAutomationRunCandidatesInternalQueryParams,
  ListAutomationRunCandidatesInternalResponse,
} from '@cadenway/contracts/validators/internal/automation-service';
import { Controller, Get, Header, Inject, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';

import { ListAutomationRunCandidates } from '../../../../application/use-cases/queries/runs/list-automation-run-candidates/list-automation-run-candidates.use-case.js';
import {
  AUTOMATION_CURSOR_AUTHENTICATION,
  encodeRunCursor,
  runCursor,
  type CursorAuthentication,
} from '../../mappers/automations/automation-cursor.mapper.js';
import { automationScope } from './automations.controller.js';

/** Lists applied execution candidates for authorization by the gateway. */
@Controller('internal/v1/automation-runs')
@InternalAccess({ issuers: ['api-gateway'], actors: ['user'], organization: 'required' })
export class AutomationRunsController {
  // #region Constructor
  /** Binds the bounded history reader. */
  public constructor(
    private readonly candidates: ListAutomationRunCandidates,
    @Inject(AUTOMATION_CURSOR_AUTHENTICATION) private readonly cursorAuth: CursorAuthentication,
  ) {}
  // #endregion

  // #region Methods
  /** Returns a page from a fixed window of at most 100 applied actions. */
  @Get()
  @Header('Cache-Control', 'private, no-store')
  public async list(
    @Req() request: Request,
    @Query(new ZodValidationPipe(ListAutomationRunCandidatesInternalQueryParams.strict()))
    query: z.output<typeof ListAutomationRunCandidatesInternalQueryParams>,
  ): Promise<z.output<typeof ListAutomationRunCandidatesInternalResponse>> {
    const caller = automationScope(request);
    delete request.headers['if-none-match'];
    delete request.headers['if-modified-since'];
    const filters = { ...caller, operation: 'list-automation-runs' };
    const input =
      query.cursor === undefined
        ? { upper: null, after: null, remaining: 100, limit: query.limit }
        : runCursor(this.cursorAuth.authenticate(query.cursor), filters, query.limit);
    const page = await this.candidates.execute(caller.organizationId, input);
    if (page.next !== null && page.upper === null) {
      throw new Error('An automation history continuation has no fixed upper bound.');
    }
    return ListAutomationRunCandidatesInternalResponse.parse({
      items: page.items.map((run) => ({
        executionId: run.id,
        ruleId: run.ruleId,
        taskKey: run.taskKey,
        action: run.action.type === 'comment' ? { type: 'comment' } : run.action,
        executedAt: run.executedAt?.toISOString(),
      })),
      nextCursor:
        page.next === null || page.upper === null
          ? null
          : this.cursorAuth.sign(encodeRunCursor(page.upper, page.next, page.remaining, filters)),
    });
  }
  // #endregion
}
