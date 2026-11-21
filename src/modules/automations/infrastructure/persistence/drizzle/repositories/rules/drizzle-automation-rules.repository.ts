import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type { AutomationRulePage } from '../../../../../application/models/rules/automation-rule-page.model.js';
import type { AutomationRulePosition } from '../../../../../application/models/rules/automation-rule-position.model.js';
import type { AutomationRulesReader } from '../../../../../application/ports/outbound/persistence/rules/automation-rules-reader.port.js';
import type { AutomationTriggerRulesReader } from '../../../../../application/ports/outbound/persistence/rules/automation-trigger-rules-reader.port.js';
import type { AutomationTaskVocabulary } from '../../../../../domain/value-objects/rules/automation-task-vocabulary.value-object.js';
import { mapAutomationRule } from '../../mappers/rules/automation-rule.mapper.js';
import { automationRules } from '../../schemas/rules/automation-rules.schema.js';

/** Lists one verified tenant's rules in stable creation and UUID order. */
export class DrizzleAutomationRulesReader
  implements AutomationRulesReader, AutomationTriggerRulesReader
{
  // #region Constructor
  /** Uses the shared tenant transaction and the published Task vocabulary. */
  public constructor(
    private readonly runner: TenantTransactionRunner<DatabaseSchema>,
    private readonly vocabulary: AutomationTaskVocabulary,
  ) {}
  // #endregion

  // #region Methods
  /** Lists all rules in the organization for management. */
  public list(
    organizationId: string,
    query: { readonly after: AutomationRulePosition | null; readonly limit: number },
  ): Promise<AutomationRulePage> {
    return this.readPage(organizationId, query);
  }

  /** Filters candidates before applying the page limit and continuation. */
  public listTriggerCandidates(
    organizationId: string,
    query: Parameters<AutomationTriggerRulesReader['listTriggerCandidates']>[1],
  ): Promise<AutomationRulePage> {
    const { trigger, occurredAt, availableActions } = query;
    return this.readPage(
      organizationId,
      query,
      and(
        eq(automationRules.enabled, true),
        lte(automationRules.createdAt, occurredAt),
        eq(sql<string>`(${automationRules.trigger} ->> 'type')`, trigger.type),
        trigger.type === 'status'
          ? eq(sql<string>`(${automationRules.trigger} ->> 'status')`, trigger.status)
          : undefined,
        inArray(sql<string>`(${automationRules.action} ->> 'type')`, availableActions),
      ),
    );
  }

  /** Reads one stable keyset page with a one-row lookahead. */
  private readPage(
    organizationId: string,
    query: { readonly after: AutomationRulePosition | null; readonly limit: number },
    filters?: SQL,
  ): Promise<AutomationRulePage> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw new Error('The automation rule page limit must be between 1 and 100.');
    }
    return this.runner.run(
      async (scope) => {
        if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
          throw new Error('Rule read organization does not match the tenant transaction.');
        }
        const position = query.after;
        const rows = await scope.db
          .select()
          .from(automationRules)
          .where(
            and(
              eq(automationRules.organizationId, organizationId),
              position === null
                ? undefined
                : sql`(${automationRules.createdAt}, ${automationRules.id})
                    > (${position.createdAt.toISOString()}::timestamptz, ${position.ruleId}::uuid)`,
              filters,
            ),
          )
          .orderBy(asc(automationRules.createdAt), asc(automationRules.id))
          .limit(query.limit + 1);
        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        return {
          items: page.map((row) => mapAutomationRule(row, this.vocabulary)),
          next:
            rows.length > query.limit && last !== undefined
              ? { createdAt: last.createdAt, ruleId: last.id }
              : null,
        };
      },
      { readOnly: true },
    );
  }
  // #endregion
}
