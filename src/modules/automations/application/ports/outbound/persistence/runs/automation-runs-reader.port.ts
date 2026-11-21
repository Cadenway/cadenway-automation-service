import type { AutomationRunPage } from '../../../../models/runs/automation-run-page.model.js';
import type { AutomationRunPageRequest } from '../../../../models/runs/automation-run-page-request.model.js';

/** Reads a bounded window of the tenant's successfully applied executions. */
export interface AutomationRunsReader {
  // #region Properties
  /** Reads a page under tenant scope; presentation removes action contents from the response. */
  readonly list: (
    organizationId: string,
    request: AutomationRunPageRequest,
  ) => Promise<AutomationRunPage>;
  // #endregion
}
