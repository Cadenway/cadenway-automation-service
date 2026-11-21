import {
  formatEtag,
  InternalAccess,
  principalOf,
  ProblemException,
  ZodValidationPipe,
} from '@cadenway/nest-common';
import { Idempotent } from '@cadenway/nest-common/database';
import {
  CreateAutomationRuleInternalBody,
  CreateAutomationRuleInternalResponse,
  DeleteAutomationRuleInternalParams,
  ListAutomationRulesInternalQueryParams,
  ListAutomationRulesInternalResponse,
  UpdateAutomationRuleInternalBody,
  UpdateAutomationRuleInternalHeader,
  UpdateAutomationRuleInternalParams,
  UpdateAutomationRuleInternalResponse,
} from '@cadenway/contracts/validators/internal/automation-service';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { z as zod } from 'zod';

import { CreateAutomationRule } from '../../../../application/use-cases/commands/rules/create-automation-rule/create-automation-rule.use-case.js';
import type { CreateAutomationRuleOutput } from '../../../../application/use-cases/commands/rules/create-automation-rule/create-automation-rule.output.js';
import { DeleteAutomationRule } from '../../../../application/use-cases/commands/rules/delete-automation-rule/delete-automation-rule.use-case.js';
import { SetAutomationRuleEnabled } from '../../../../application/use-cases/commands/rules/set-automation-rule-enabled/set-automation-rule-enabled.use-case.js';
import { ListAutomationRules } from '../../../../application/use-cases/queries/rules/list-automation-rules/list-automation-rules.use-case.js';
import {
  AUTOMATION_CURSOR_AUTHENTICATION,
  encodeRuleCursor,
  ruleCursor,
  type CursorAuthentication,
} from '../../mappers/automations/automation-cursor.mapper.js';
import {
  automationCreateBody,
  AutomationRecipientGuard,
} from '../../guards/automations/automation-recipient.guard.js';

const updateParams = UpdateAutomationRuleInternalParams.strict().extend({ ruleId: zod.uuidv7() });

/** Reads the gateway user and tenant from the verified request principal. */
export function automationScope(request: Request): { organizationId: string; actorId: string } {
  const principal = principalOf(request);
  if (
    principal?.issuer !== 'api-gateway' ||
    principal.actor.type !== 'user' ||
    principal.actor.id === null ||
    principal.organizationId === null
  ) {
    throw new ProblemException({
      status: 401,
      code: 'auth.token-invalid',
      detail: 'The verified request identity is unavailable.',
    });
  }
  return { organizationId: principal.organizationId, actorId: principal.actor.id };
}

function mapRule(
  rule: Extract<CreateAutomationRuleOutput, { status: 'created' }>['rule'],
): z.output<typeof CreateAutomationRuleInternalResponse> {
  return CreateAutomationRuleInternalResponse.parse({
    ruleId: rule.ruleId,
    trigger: rule.trigger,
    action: rule.action,
    enabled: rule.enabled,
    version: rule.version,
    createdAt: rule.createdAt.toISOString(),
  });
}

function version(header: string | undefined): number | null {
  if (header === undefined) return null;
  if (!UpdateAutomationRuleInternalHeader.shape['If-Match'].safeParse(header).success) {
    throw new ProblemException({
      status: 400,
      code: 'request.invalid',
      detail: 'The request does not match its contract.',
      details: { issues: [{ in: 'header', path: 'If-Match', code: 'invalid_format' }] },
    });
  }
  const parsed = Number(header.slice(1, -1));
  if (!Number.isSafeInteger(parsed)) {
    throw new ProblemException({
      status: 400,
      code: 'request.invalid',
      detail: 'The request does not match its contract.',
      details: { issues: [{ in: 'header', path: 'If-Match', code: 'invalid_format' }] },
    });
  }
  return parsed;
}

function refuse(
  result: { status: 'not-found' } | { status: 'version-mismatch'; version: number },
): never {
  if (result.status === 'not-found') {
    throw new ProblemException({
      status: 404,
      code: 'automation.rule-not-found',
      detail: 'The automation rule was not found.',
    });
  }
  throw new ProblemException({
    status: 412,
    code: 'request.version-mismatch',
    detail: 'The automation rule changed.',
    details: { version: result.version },
  });
}

/** Manages rules within the tenant and identity verified by the internal token. */
@Controller('internal/v1/automations')
@InternalAccess({ issuers: ['api-gateway'], actors: ['user'], organization: 'required' })
export class AutomationsController {
  // #region Constructor
  /** Binds rule use cases supplied by module composition. */
  public constructor(
    private readonly listRules: ListAutomationRules,
    private readonly createRule: CreateAutomationRule,
    private readonly updateRule: SetAutomationRuleEnabled,
    private readonly deleteRule: DeleteAutomationRule,
    @Inject(AUTOMATION_CURSOR_AUTHENTICATION) private readonly cursorAuth: CursorAuthentication,
  ) {}
  // #endregion

  // #region Methods
  /** Lists rules using a continuation bound to the caller and tenant. */
  @Get()
  @Header('Cache-Control', 'private, no-store')
  public async list(
    @Req() request: Request,
    @Query(new ZodValidationPipe(ListAutomationRulesInternalQueryParams.strict()))
    query: z.output<typeof ListAutomationRulesInternalQueryParams>,
  ): Promise<z.output<typeof ListAutomationRulesInternalResponse>> {
    const caller = automationScope(request);
    delete request.headers['if-none-match'];
    delete request.headers['if-modified-since'];
    const filters = { ...caller, operation: 'list-automation-rules' };
    const page = await this.listRules.execute({
      organizationId: caller.organizationId,
      after:
        query.cursor === undefined
          ? null
          : ruleCursor(this.cursorAuth.authenticate(query.cursor), filters),
      limit: query.limit,
    });
    return ListAutomationRulesInternalResponse.parse({
      items: page.items.map((rule) => mapRule(rule.snapshot())),
      nextCursor:
        page.next === null ? null : this.cursorAuth.sign(encodeRuleCursor(page.next, filters)),
    });
  }

  /** Creates a rule using the verified actor as its author. */
  @Post()
  @UseGuards(AutomationRecipientGuard)
  @Idempotent({ maxAttempts: 1, scope: 'actor' })
  @Header('Cache-Control', 'private, no-store')
  public async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body(new ZodValidationPipe(automationCreateBody))
    body: z.output<typeof CreateAutomationRuleInternalBody>,
  ): Promise<z.output<typeof CreateAutomationRuleInternalResponse>> {
    const caller = automationScope(request);
    const result = await this.createRule.execute({
      organizationId: caller.organizationId,
      ruleAuthorUserId: caller.actorId,
      ...body,
    });
    if (result.status === 'recipient-not-active') {
      throw new ProblemException({
        status: 422,
        code: 'automation.recipient-ineligible',
        detail: 'The recipient is not an active organization member.',
      });
    }
    const rule = mapRule(result.rule);
    response.setHeader('Location', `/internal/v1/automations/${rule.ruleId}`);
    response.setHeader('ETag', formatEtag(rule.version));
    return rule;
  }

  /** Changes the enabled state under the optional version precondition. */
  @Patch(':ruleId')
  @Header('Cache-Control', 'private, no-store')
  public async update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param(new ZodValidationPipe(updateParams))
    params: z.output<typeof UpdateAutomationRuleInternalParams>,
    @Headers('if-match')
    ifMatch: string | undefined,
    @Body(new ZodValidationPipe(UpdateAutomationRuleInternalBody))
    body: z.output<typeof UpdateAutomationRuleInternalBody>,
  ): Promise<z.output<typeof UpdateAutomationRuleInternalResponse>> {
    const caller = automationScope(request);
    const result = await this.updateRule.execute({
      organizationId: caller.organizationId,
      ruleId: params.ruleId,
      expectedVersion: version(ifMatch),
      enabled: body.enabled,
    });
    if (result.status !== 'updated') return refuse(result);
    response.setHeader('ETag', formatEtag(result.rule.version));
    return UpdateAutomationRuleInternalResponse.parse(mapRule(result.rule));
  }

  /** Deletes a rule after checking its optional version. */
  @Delete(':ruleId')
  @HttpCode(204)
  @Header('Cache-Control', 'private, no-store')
  public async remove(
    @Req() request: Request,
    @Param(
      new ZodValidationPipe(
        DeleteAutomationRuleInternalParams.strict().extend({ ruleId: zod.uuidv7() }),
      ),
    )
    params: z.output<typeof DeleteAutomationRuleInternalParams>,
    @Headers('if-match')
    ifMatch: string | undefined,
  ): Promise<void> {
    const caller = automationScope(request);
    const result = await this.deleteRule.execute({
      organizationId: caller.organizationId,
      ruleId: params.ruleId,
      expectedVersion: version(ifMatch),
    });
    if (result.status !== 'deleted') refuse(result);
  }
  // #endregion
}
