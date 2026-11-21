import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, eq, sql } from 'drizzle-orm';

import type { AutomationRulesTransaction } from '../../../../../application/ports/outbound/transactions/rules/automation-rules-transaction.port.js';
import type { AutomationRulesUnitOfWork } from '../../../../../application/ports/outbound/transactions/rules/automation-rules-unit-of-work.port.js';
import type { AutomationTaskVocabulary } from '../../../../../domain/value-objects/rules/automation-task-vocabulary.value-object.js';
import { mapAutomationRule } from '../../mappers/rules/automation-rule.mapper.js';
import { automationRules } from '../../schemas/rules/automation-rules.schema.js';

/** Executes rule mutations on a tenant transaction managed by the service kit. */
export class DrizzleAutomationRulesUnitOfWork implements AutomationRulesUnitOfWork {
  // #region Constructor
  /** Uses the tenant transaction runner and the shared Task vocabulary. */
  public constructor(
    private readonly runner: TenantTransactionRunner<DatabaseSchema>,
    private readonly vocabulary: AutomationTaskVocabulary,
  ) {}
  // #endregion

  // #region Methods
  /** Joins the request transaction and refuses a mismatched organization context. */
  public run<T>(
    organizationId: string,
    work: (transaction: AutomationRulesTransaction) => Promise<T>,
  ): Promise<T> {
    return this.runner.run(async (scope) => {
      if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
        throw new Error('Rule write organization does not match the tenant transaction.');
      }
      const transaction: AutomationRulesTransaction = {
        allocateIdentity: async () => {
          const result = await scope.client.query(
            "select uuidv7()::text as id, date_trunc('milliseconds', now()) as created_at",
          );
          const row = result.rows[0];
          if (
            typeof row !== 'object' ||
            row === null ||
            !('id' in row) ||
            typeof row.id !== 'string' ||
            !('created_at' in row) ||
            !(row.created_at instanceof Date)
          ) {
            throw new Error('PostgreSQL did not allocate a rule identity.');
          }
          return { ruleId: row.id, createdAt: row.created_at };
        },
        find: async (ruleId) => {
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
        insert: async (rule) => {
          const state = rule.snapshot();
          if (state.organizationId !== organizationId) {
            throw new Error('Rule organization does not match the tenant transaction.');
          }
          await scope.db.insert(automationRules).values({
            organizationId,
            id: state.ruleId,
            ruleAuthorUserId: state.ruleAuthorUserId,
            trigger: state.trigger,
            action: state.action,
            enabled: state.enabled,
            version: state.version,
            createdAt: state.createdAt,
          });
        },
        save: async (rule, expectedVersion) => {
          const state = rule.snapshot();
          if (state.organizationId !== organizationId) {
            throw new Error('Rule organization does not match the tenant transaction.');
          }
          const rows = await scope.db
            .update(automationRules)
            .set({ enabled: state.enabled, version: state.version, updatedAt: sql`now()` })
            .where(
              and(
                eq(automationRules.organizationId, organizationId),
                eq(automationRules.id, state.ruleId),
                eq(automationRules.version, expectedVersion),
              ),
            )
            .returning({ id: automationRules.id });
          return rows.length === 1;
        },
        delete: async (ruleId, expectedVersion) => {
          const rows = await scope.db
            .delete(automationRules)
            .where(
              and(
                eq(automationRules.organizationId, organizationId),
                eq(automationRules.id, ruleId),
                eq(automationRules.version, expectedVersion),
              ),
            )
            .returning({ id: automationRules.id });
          return rows.length === 1;
        },
      };
      return work(transaction);
    });
  }
  // #endregion
}
