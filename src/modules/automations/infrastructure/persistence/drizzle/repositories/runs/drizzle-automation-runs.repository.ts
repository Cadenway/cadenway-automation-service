import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, desc, eq, lt, lte, or } from 'drizzle-orm';

import type { AutomationRunPageRequest } from '../../../../../application/models/runs/automation-run-page-request.model.js';
import type { AutomationRunPage } from '../../../../../application/models/runs/automation-run-page.model.js';
import type { AutomationRunPosition } from '../../../../../application/models/runs/automation-run-position.model.js';
import type { AutomationRunsReader } from '../../../../../application/ports/outbound/persistence/runs/automation-runs-reader.port.js';
import { automationRuns } from '../../schemas/runs/automation-runs.schema.js';

/** Pages over a tenant's bounded, fixed window of successfully applied executions. */
export class DrizzleAutomationRunsReader implements AutomationRunsReader {
  // #region Constructor
  /** Uses the shared tenant transaction runner. */
  public constructor(private readonly runner: TenantTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Reads a descending keyset page with at most one hundred candidates per window. */
  public list(
    organizationId: string,
    request: AutomationRunPageRequest,
  ): Promise<AutomationRunPage> {
    if (
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100 ||
      !Number.isInteger(request.remaining) ||
      request.remaining < 0 ||
      request.remaining > 100 ||
      (request.upper === null && request.after !== null)
    ) {
      throw new Error('The automation run window is invalid.');
    }
    return this.runner.run(
      async (scope) => {
        if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
          throw new Error('Run read organization does not match the tenant transaction.');
        }
        if (request.remaining === 0) {
          return { items: [], upper: request.upper, next: null, remaining: 0 };
        }
        const upper = request.upper;
        const after = request.after;
        const pageSize = Math.min(request.limit, request.remaining);
        const rows = await scope.db
          .select()
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.organizationId, organizationId),
              eq(automationRuns.status, 'applied'),
              upper === null
                ? undefined
                : or(
                    lt(automationRuns.executedAt, upper.executedAt),
                    and(
                      eq(automationRuns.executedAt, upper.executedAt),
                      lte(automationRuns.id, upper.id),
                    ),
                  ),
              after === null
                ? undefined
                : or(
                    lt(automationRuns.executedAt, after.executedAt),
                    and(
                      eq(automationRuns.executedAt, after.executedAt),
                      lt(automationRuns.id, after.id),
                    ),
                  ),
            ),
          )
          .orderBy(desc(automationRuns.executedAt), desc(automationRuns.id))
          .limit(pageSize + 1);
        const items = rows.slice(0, pageSize);
        const first = items[0];
        const last = items.at(-1);
        const position = (run: (typeof rows)[number]): AutomationRunPosition => {
          if (run.executedAt === null) throw new Error('An applied run has no execution time.');
          return { executedAt: run.executedAt, id: run.id };
        };
        const fixedUpper = upper ?? (first === undefined ? null : position(first));
        const remaining = request.remaining - items.length;
        const hasNext = remaining > 0 && rows.length > pageSize && last !== undefined;
        return {
          items,
          upper: fixedUpper,
          next: hasNext ? position(last) : null,
          remaining: hasNext ? remaining : 0,
        };
      },
      { readOnly: true },
    );
  }
  // #endregion
}
