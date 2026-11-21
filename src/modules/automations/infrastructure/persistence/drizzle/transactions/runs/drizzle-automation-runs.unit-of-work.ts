import type {
  DatabaseSchema,
  TenantTransactionRunner,
  TransactionScope,
} from '@cadenway/nest-common/database';
import { and, eq, sql } from 'drizzle-orm';

import type { AutomationRun } from '../../../../../application/models/runs/automation-run.model.js';
import type { AutomationRunsTransaction } from '../../../../../application/ports/outbound/transactions/runs/automation-runs-transaction.port.js';
import type { AutomationRunsUnitOfWork } from '../../../../../application/ports/outbound/transactions/runs/automation-runs-unit-of-work.port.js';
import type { AutomationTaskVocabulary } from '../../../../../domain/value-objects/rules/automation-task-vocabulary.value-object.js';
import { mapAutomationRule } from '../../mappers/rules/automation-rule.mapper.js';
import { automationRules } from '../../schemas/rules/automation-rules.schema.js';
import { automationRuns } from '../../schemas/runs/automation-runs.schema.js';

/** Owns execution decisions and the outbox append in a single tenant transaction. */
export class DrizzleAutomationRunsUnitOfWork implements AutomationRunsUnitOfWork {
  // #region Constructor
  /** Uses the shared tenant runner, Task vocabulary and transaction-bound event writer. */
  public constructor(
    private readonly runner: TenantTransactionRunner<DatabaseSchema>,
    private readonly vocabulary: AutomationTaskVocabulary,
    private readonly appendExecuted: (
      scope: TransactionScope<DatabaseSchema>,
      run: AutomationRun,
    ) => Promise<void>,
  ) {}
  // #endregion

  // #region Methods
  /** Joins the current verified tenant and commits all callback operations together. */
  public run<T>(
    organizationId: string,
    work: (transaction: AutomationRunsTransaction) => Promise<T>,
  ): Promise<T> {
    return this.runner.run(async (scope) => {
      if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
        throw new Error('Run write organization does not match the tenant transaction.');
      }
      const findBySource = async (ruleId: string, sourceEventId: string) => {
        const rows = await scope.db
          .select()
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.organizationId, organizationId),
              eq(automationRuns.ruleId, ruleId),
              eq(automationRuns.sourceEventId, sourceEventId),
            ),
          )
          .limit(1);
        return rows[0] ?? null;
      };
      const transaction: AutomationRunsTransaction = {
        findBySource,
        lockRule: async (ruleId) => {
          const rows = await scope.db
            .select()
            .from(automationRules)
            .where(
              and(
                eq(automationRules.organizationId, organizationId),
                eq(automationRules.id, ruleId),
              ),
            )
            .limit(1)
            .for('update');
          return rows[0] === undefined ? null : mapAutomationRule(rows[0], this.vocabulary);
        },
        reserve: async (input) => {
          const inserted = await scope.db
            .insert(automationRuns)
            .values({ organizationId, ...input })
            .onConflictDoNothing({
              target: [
                automationRuns.organizationId,
                automationRuns.ruleId,
                automationRuns.sourceEventId,
              ],
            })
            .returning();
          const run = inserted[0] ?? (await findBySource(input.ruleId, input.sourceEventId));
          if (run === null) throw new Error('The reserved automation run could not be read.');
          return run;
        },
        settle: async (runId, disposition) => {
          const rows = await scope.db
            .update(automationRuns)
            .set({
              status: disposition,
              executedAt: disposition === 'applied' ? sql`date_trunc('milliseconds', now())` : null,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(automationRuns.organizationId, organizationId),
                eq(automationRuns.id, runId),
                eq(automationRuns.status, 'pending'),
              ),
            )
            .returning({ id: automationRuns.id });
          return rows.length === 1;
        },
        appendExecuted: async (run) => {
          const rows = await scope.db
            .select()
            .from(automationRuns)
            .where(
              and(
                eq(automationRuns.organizationId, organizationId),
                eq(automationRuns.id, run.id),
                eq(automationRuns.status, 'applied'),
              ),
            )
            .limit(1);
          const applied = rows[0];
          if (applied === undefined) throw new Error('The applied automation run was not found.');
          await this.appendExecuted(scope, applied);
        },
      };
      return work(transaction);
    });
  }
  // #endregion
}
