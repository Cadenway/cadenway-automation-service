import type { AutomationAction } from '../../../../../domain/value-objects/rules/automation-action.value-object.js';
import type { AutomationRun } from '../../../../models/runs/automation-run.model.js';
import type { AutomationActionExecutor } from '../../../../ports/outbound/actions/runs/automation-action-executor.port.js';
import type { AutomationRunsUnitOfWork } from '../../../../ports/outbound/transactions/runs/automation-runs-unit-of-work.port.js';
import type { ExecuteAutomationRuleInput } from './execute-automation-rule.input.js';
import type { ExecuteAutomationRuleOutput } from './execute-automation-rule.output.js';

// Task retains an idempotency receipt for at least 24 hours; leave time for an in-flight call.
const retryWindowMs = 23 * 60 * 60 * 1_000;
const allowedClockSkewMs = 60 * 1_000;

/** Reserves and carries out a matching rule once for an authenticated source fact. */
export class ExecuteAutomationRule {
  // #region Constructor
  /** Binds the tenant transaction and the downstream action owner and rollout. */
  public constructor(
    private readonly work: AutomationRunsUnitOfWork,
    private readonly actions: AutomationActionExecutor,
    private readonly availableActions: readonly AutomationAction['type'][],
    private readonly now: () => Date = () => new Date(),
  ) {}
  // #endregion

  // #region Methods
  /** Resumes a durable decision or creates one under a lock on the current rule. */
  public async execute(
    input: ExecuteAutomationRuleInput,
    signal?: AbortSignal,
  ): Promise<ExecuteAutomationRuleOutput> {
    signal?.throwIfAborted();
    if (input.organizationId.toLowerCase() !== input.fact.organizationId.toLowerCase()) {
      throw new Error('Automation source organization does not match the transaction.');
    }
    const run = await this.work.run(input.organizationId, async (transaction) => {
      const existing = await transaction.findBySource(input.ruleId, input.sourceEventId);
      if (existing !== null) return existing;
      if (!input.allowNewReservation) return null;
      const rule = await transaction.lockRule(input.ruleId);
      const concurrent = await transaction.findBySource(input.ruleId, input.sourceEventId);
      if (concurrent !== null) return concurrent;
      if (rule?.matches(input.fact) !== true) return null;
      const state = rule.snapshot();
      if (!this.availableActions.includes(state.action.type)) {
        return null;
      }
      return transaction.reserve({
        ruleId: state.ruleId,
        sourceEventId: input.sourceEventId,
        taskKey: input.taskKey,
        action: state.action,
        ruleAuthorUserId: state.ruleAuthorUserId,
      });
    });
    if (run === null) return { status: 'ignored' };
    if (run.taskKey !== input.taskKey) throw new Error('Automation source event has changed task.');
    if (run.status !== 'pending') return { status: run.status, runId: run.id };

    const ageMs = this.now().getTime() - run.createdAt.getTime();
    if (!Number.isFinite(ageMs) || ageMs < -allowedClockSkewMs || ageMs >= retryWindowMs) {
      throw new Error('Automation action is outside its downstream retry window.');
    }
    signal?.throwIfAborted();
    const disposition = await this.actions.execute(run, signal);
    return this.finish(input.organizationId, run, disposition);
  }

  /** Commits an applied outcome and its outbox event atomically after the remote call. */
  private async finish(
    organizationId: string,
    run: AutomationRun,
    disposition: 'applied' | 'no_op',
  ): Promise<ExecuteAutomationRuleOutput> {
    await this.work.run(organizationId, async (transaction) => {
      const changed = await transaction.settle(run.id, disposition);
      if (changed && disposition === 'applied') await transaction.appendExecuted(run);
    });
    return { status: disposition, runId: run.id };
  }
  // #endregion
}
