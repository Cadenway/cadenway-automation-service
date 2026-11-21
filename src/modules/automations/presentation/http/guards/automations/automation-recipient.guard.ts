import { CreateAutomationRuleInternalBody } from '@cadenway/contracts/validators/internal/automation-service';
import { principalOf, ProblemException, ZodValidationPipe } from '@cadenway/nest-common';
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

/** The creation contract with the UUIDv7 invariant required for recipient accounts. */
export const automationCreateBody = CreateAutomationRuleInternalBody.refine(
  ({ action }) =>
    (action.type !== 'assign' && action.type !== 'notify') ||
    z.uuidv7().safeParse(action.userId).success,
  { path: ['action', 'userId'], message: 'Expected a UUIDv7 account identifier.' },
);

/** Checks the gateway's current recipient proof before the idempotency interceptor can replay. */
@Injectable()
export class AutomationRecipientGuard implements CanActivate {
  // #region Methods
  /** Validates the body and requires a matching verified scope for recipient actions. */
  public canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const body = automationCreateBody.safeParse(request.body);
    if (!body.success) {
      new ZodValidationPipe(automationCreateBody).transform(request.body, { type: 'body' });
      return false;
    }
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
    const { action } = body.data;
    if (
      (action.type === 'assign' || action.type === 'notify') &&
      !principal.scopes.includes(`automation:recipient:${action.userId.toLowerCase()}`)
    ) {
      throw new ProblemException({
        status: 422,
        code: 'automation.recipient-ineligible',
        detail: 'The recipient is not an active organization member.',
      });
    }
    return true;
  }
  // #endregion
}
