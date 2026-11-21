import type { AutomationRunPage } from '../../../../models/runs/automation-run-page.model.js';
import type { AutomationRunPageRequest } from '../../../../models/runs/automation-run-page-request.model.js';
import type { AutomationRunsReader } from '../../../../ports/outbound/persistence/runs/automation-runs-reader.port.js';

/** Lists applied executions within one fixed tenant history window. */
export class ListAutomationRunCandidates {
  // #region Constructor
  /** Uses the owning repository's bounded tenant read. */
  public constructor(private readonly reader: AutomationRunsReader) {}
  // #endregion

  // #region Methods
  /** Lists the next page of candidate executions for the requesting organization. */
  public execute(
    organizationId: string,
    request: AutomationRunPageRequest,
  ): Promise<AutomationRunPage> {
    return this.reader.list(organizationId, request);
  }
  // #endregion
}
