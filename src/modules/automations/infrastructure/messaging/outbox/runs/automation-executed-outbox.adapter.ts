import {
  AUTOMATION_EXECUTED_V1,
  eventSchemas,
} from '@cadenway/contracts/events/automation-service';
import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';
import { Injectable } from '@nestjs/common';

import type { AutomationRun } from '../../../../application/models/runs/automation-run.model.js';

/** Records the fact of a successful action in the transaction that settles the run. */
@Injectable()
export class AutomationExecutedOutbox {
  // #region Constructor
  /** Uses the kit's transaction-bound writer and contract validation. */
  public constructor(private readonly writer: OutboxWriter) {}
  // #endregion

  // #region Methods
  /** Appends only once the caller wins the pending-to-applied transition for this tenant. */
  public async append(scope: TransactionScope<DatabaseSchema>, run: AutomationRun): Promise<void> {
    if (scope.kind !== 'tenant' || scope.organizationId !== run.organizationId) {
      throw new Error('Automation event does not belong to the tenant transaction.');
    }
    if (run.status !== 'applied' || run.executedAt === null) {
      throw new Error('Only a recorded successful automation run emits an execution event.');
    }

    const { occurredAt } = await this.writer.append(scope, eventSchemas, AUTOMATION_EXECUTED_V1, {
      organizationId: run.organizationId,
      actor: { type: 'automation', id: run.ruleId },
      version: 1,
      executionId: run.id,
      ruleId: run.ruleId,
      triggerEventId: run.sourceEventId,
      taskKey: run.taskKey,
      actionType: run.action.type,
    });
    // The writer and the settlement use the start of the same PostgreSQL transaction.
    if (occurredAt !== run.executedAt.toISOString()) {
      throw new Error('Automation event time does not match the recorded execution.');
    }
  }
  // #endregion
}
