import type { AutomationAction } from '../../../../../domain/value-objects/rules/automation-action.value-object.js';
import type { AutomationTrigger } from '../../../../../domain/value-objects/rules/automation-trigger.value-object.js';
import type { AutomationRulePage } from '../../../../models/rules/automation-rule-page.model.js';
import type { AutomationRulePosition } from '../../../../models/rules/automation-rule-position.model.js';

/** Selects one ordered page of rules eligible to react to a task trigger. */
export interface AutomationTriggerRulesReader {
  // #region Properties
  /** Filters by tenant, enablement, creation time, trigger and the available actions. */
  readonly listTriggerCandidates: (
    organizationId: string,
    query: Readonly<{
      after: AutomationRulePosition | null;
      limit: number;
      occurredAt: Date;
      trigger: AutomationTrigger;
      availableActions: readonly AutomationAction['type'][];
    }>,
  ) => Promise<AutomationRulePage>;
  // #endregion
}
