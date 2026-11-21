import type { AutomationRulesReader } from '../../../../ports/outbound/persistence/rules/automation-rules-reader.port.js';
import type { ListAutomationRulesInput } from './list-automation-rules.input.js';
import type { ListAutomationRulesOutput } from './list-automation-rules.output.js';

/** Reads a bounded page of rules ordered by creation time and rule ID. */
export class ListAutomationRules {
  // #region Constructor
  /** Binds the tenant-scoped rule reader. */
  public constructor(private readonly reader: AutomationRulesReader) {}
  // #endregion

  // #region Methods
  /** Delegates the page to the reader using the verified tenant. */
  public execute(input: ListAutomationRulesInput): Promise<ListAutomationRulesOutput> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RangeError('Automation rule page size must be between 1 and 100.');
    }
    return this.reader.list(input.organizationId, { after: input.after, limit: input.limit });
  }
  // #endregion
}
