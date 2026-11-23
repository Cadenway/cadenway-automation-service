import {
  ApplyAutomationTaskActionInternalBody,
  ApplyAutomationTaskActionInternalParams,
  ApplyAutomationTaskActionInternalResponse,
  ApplyAutomationTaskCommentInternalBody,
  ApplyAutomationTaskCommentInternalParams,
  ApplyAutomationTaskCommentInternalResponse,
} from '@cadenway/contracts/validators/internal/task-service';
import {
  CreateAutomationNotificationInternalBody,
  CreateAutomationNotificationInternalResponse,
} from '@cadenway/contracts/validators/internal/notification-service';
import { ProblemException } from '@cadenway/nest-common';
import type { InternalHttpClient, InternalRequestInit } from '@cadenway/nest-common';
import type { output, ZodType } from 'zod';

import type { AutomationRun } from '../../../application/models/runs/automation-run.model.js';
import type { AutomationActionExecutor } from '../../../application/ports/outbound/actions/runs/automation-action-executor.port.js';
import { getNotificationServiceInternalRoutes } from '../notification-service/generated/notification-service.js';
import { getTaskServiceInternalRoutes } from '../task-service/generated/task-service.js';

const actionReceipt = ApplyAutomationTaskActionInternalResponse.strict();
const commentReceipt = ApplyAutomationTaskCommentInternalResponse.strict();
const notificationReceipt = CreateAutomationNotificationInternalResponse.strict();
const ownerProblems = [
  { status: 400, codes: ['request.invalid'] },
  {
    status: 403,
    codes: ['auth.issuer-not-allowed', 'auth.actor-not-allowed', 'auth.organization-required'],
  },
  { status: 404, codes: ['task.not-found', 'notification.not-found'] },
  { status: 409, codes: ['idempotency.request-in-progress'] },
  { status: 422, codes: ['idempotency.key-reused'] },
  {
    status: 503,
    codes: ['task.action-unavailable', 'upstream.unavailable', 'upstream.unauthorized'],
  },
] as const;

type Receipt = output<typeof actionReceipt>;
type Disposition = Receipt['disposition'];

interface OwnerResponse {
  // #region Properties
  /** Transport status before validating the receipt. */
  readonly status: number;

  /** Headers carrying the content type and private caching policy. */
  readonly headers: Headers;

  /** JSON received from the owning service. */
  readonly data: unknown;
  // #endregion
}

function readReceipt(response: OwnerResponse, schema: ZodType<Receipt>): Disposition {
  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    response.status !== 200 ||
    response.headers.get('Cache-Control') !== 'private, no-store' ||
    contentType !== 'application/json'
  ) {
    throw new Error('The action owner did not return a private receipt.');
  }
  const receipt = schema.safeParse(response.data);
  if (!receipt.success) throw new Error('The action owner returned an invalid receipt.');
  return receipt.data.disposition;
}

function sanitizeFailure(error: unknown): Error {
  if (error instanceof ProblemException) {
    const { status, code } = error.problem;
    const problem = ownerProblems.find((known) => known.status === status);
    if (problem !== undefined) {
      return new ProblemException({
        status: problem.status,
        code: problem.codes.some((known) => known === code) ? code : 'upstream.error',
      });
    }
  }
  return new Error('The automation action could not be confirmed.');
}

/** Dispatches a reserved rule action to the service that owns its write. */
export class AutomationActionHttpAdapter implements AutomationActionExecutor {
  // #region Properties
  /** The generated Task operation using the shared internal HTTP transport. */
  private readonly taskRoutes: ReturnType<typeof getTaskServiceInternalRoutes>;

  /** The generated Notification operation, retained for recovery whenever configured. */
  private readonly notificationRoutes:
    ReturnType<typeof getNotificationServiceInternalRoutes> | undefined;
  // #endregion

  // #region Constructor
  /** Binds the signed Task transport and the optional signed Notification transport. */
  public constructor(task: InternalHttpClient, notification?: InternalHttpClient) {
    this.taskRoutes = getTaskServiceInternalRoutes((path, init) => {
      if (typeof path !== 'string') throw new Error('Expected a generated Task request path.');
      return task.fetch(path, init);
    });
    this.notificationRoutes =
      notification === undefined
        ? undefined
        : getNotificationServiceInternalRoutes((path, init) => {
            if (typeof path !== 'string') {
              throw new Error('Expected a generated Notification request path.');
            }
            return notification.fetch(path, init);
          });
  }
  // #endregion

  // #region Methods
  /** Uses the durable run key and returns the validated, private disposition from its owner. */
  public async execute(run: AutomationRun, signal?: AbortSignal): Promise<Disposition> {
    signal?.throwIfAborted();
    const { action, ruleAuthorUserId } = run;
    const options: InternalRequestInit = {
      claims: {
        organizationId: run.organizationId,
        actor: { type: 'automation', id: run.ruleId.toLowerCase() },
      },
      headers: { 'Idempotency-Key': run.id },
      signal,
    };
    if (action.type === 'assign' || action.type === 'priority') {
      const { taskKey } = ApplyAutomationTaskActionInternalParams.parse({ taskKey: run.taskKey });
      const command = ApplyAutomationTaskActionInternalBody.parse({ ...action, ruleAuthorUserId });
      const response = await this.taskRoutes.applyAutomationTaskActionInternal(
        taskKey,
        command,
        options,
      );
      return readReceipt(response, actionReceipt);
    }
    try {
      if (action.type === 'comment') {
        const { taskKey } = ApplyAutomationTaskCommentInternalParams.parse({
          taskKey: run.taskKey,
        });
        const command = ApplyAutomationTaskCommentInternalBody.parse({
          ruleAuthorUserId,
          body: action.body,
        });
        const response = await this.taskRoutes.applyAutomationTaskCommentInternal(
          taskKey,
          command,
          options,
        );
        return readReceipt(response, commentReceipt);
      }
      const notificationRoutes = this.notificationRoutes;
      if (notificationRoutes === undefined) {
        throw new Error('The Notification action transport is not configured.');
      }
      const command = CreateAutomationNotificationInternalBody.parse({
        taskKey: run.taskKey,
        ruleAuthorUserId,
        recipientUserId: action.userId,
      });
      const response = await notificationRoutes.createAutomationNotificationInternal(
        command,
        options,
      );
      return readReceipt(response, notificationReceipt);
    } catch (error) {
      signal?.throwIfAborted();
      throw sanitizeFailure(error);
    }
  }
  // #endregion
}
