import {
  ApplyAutomationTaskActionInternalBody,
  ApplyAutomationTaskActionInternalParams,
  ApplyAutomationTaskActionInternalResponse,
} from '@cadenway/contracts/validators/internal/task-service';
import type { InternalHttpClient, InternalRequestInit } from '@cadenway/nest-common';

import type { AutomationRun } from '../../../application/models/runs/automation-run.model.js';
import type { AutomationActionExecutor } from '../../../application/ports/outbound/actions/runs/automation-action-executor.port.js';
import { getTaskServiceInternalRoutes } from './generated/task-service.js';

const actionReceipt = ApplyAutomationTaskActionInternalResponse.strict();

/** Dispatches a reserved assignment or priority action to its owning service. */
export class AutomationTaskHttpAdapter implements AutomationActionExecutor {
  // #region Properties
  /** The generated Task operation using the shared internal HTTP transport. */
  private readonly routes: ReturnType<typeof getTaskServiceInternalRoutes>;
  // #endregion

  // #region Constructor
  /** Binds the Automation-signed Task transport. */
  public constructor(http: InternalHttpClient) {
    this.routes = getTaskServiceInternalRoutes((path, init) => {
      if (typeof path !== 'string') throw new Error('Expected a generated Task request path.');
      return http.fetch(path, init);
    });
  }
  // #endregion

  // #region Methods
  /** Uses the durable run key and returns only a validated, private Task receipt. */
  public async execute(run: AutomationRun, signal?: AbortSignal): Promise<'applied' | 'no_op'> {
    signal?.throwIfAborted();
    const { action, ruleAuthorUserId } = run;
    if (action.type !== 'assign' && action.type !== 'priority') {
      throw new Error('No published execution command is available for this automation action.');
    }
    const { taskKey } = ApplyAutomationTaskActionInternalParams.parse({ taskKey: run.taskKey });
    const command = ApplyAutomationTaskActionInternalBody.parse({ ...action, ruleAuthorUserId });
    const options: InternalRequestInit = {
      claims: {
        organizationId: run.organizationId,
        actor: { type: 'automation', id: run.ruleId },
      },
      headers: { 'Idempotency-Key': run.id },
      signal,
    };
    const response = await this.routes.applyAutomationTaskActionInternal(taskKey, command, options);
    const contentType = response.headers
      .get('Content-Type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      response.status !== 200 ||
      response.headers.get('Cache-Control') !== 'private, no-store' ||
      contentType !== 'application/json'
    ) {
      throw new Error('Task did not return a private automation action receipt.');
    }
    const receipt = actionReceipt.safeParse(response.data);
    if (!receipt.success) throw new Error('Task returned an invalid automation action receipt.');
    return receipt.data.disposition;
  }
  // #endregion
}
