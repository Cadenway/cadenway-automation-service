import { AutomationRule } from '../../../../../domain/aggregates/rules/automation-rule.aggregate.js';
import type { AutomationTaskVocabulary } from '../../../../../domain/value-objects/rules/automation-task-vocabulary.value-object.js';
import type { automationRules } from '../../schemas/rules/automation-rules.schema.js';

/** Restores stored rules through the domain's invariant checks. */
export function mapAutomationRule(
  row: typeof automationRules.$inferSelect,
  vocabulary: AutomationTaskVocabulary,
): AutomationRule {
  return AutomationRule.restore(
    {
      ruleId: row.id,
      organizationId: row.organizationId,
      ruleAuthorUserId: row.ruleAuthorUserId,
      trigger: row.trigger,
      action: row.action,
      enabled: row.enabled,
      version: row.version,
      createdAt: row.createdAt,
    },
    vocabulary,
  );
}
