import type { AutomationTaskTriggerJob } from '../../../../models/runs/automation-task-trigger-job.model.js';
import type { AutomationTriggerJobs } from '../../../../ports/outbound/jobs/runs/automation-trigger-jobs.port.js';
import type { AutomationRulesReader } from '../../../../ports/outbound/persistence/rules/automation-rules-reader.port.js';
import type { ExecuteAutomationRule } from '../execute-automation-rule/execute-automation-rule.use-case.js';
import type { DispatchAutomationTaskTriggerInput } from './dispatch-automation-task-trigger.input.js';

const rulesPerPage = 32;

/** Dispatches one bounded page of rules or one independently retryable action. */
export class DispatchAutomationTaskTrigger {
  // #region Constructor
  /** Binds the paginated rule reader, durable queue and single-rule command. */
  public constructor(
    private readonly rules: AutomationRulesReader,
    private readonly jobs: AutomationTriggerJobs,
    private readonly action: Pick<ExecuteAutomationRule, 'execute'>,
  ) {}
  // #endregion

  // #region Methods
  /** Keeps action HTTP outside both the broker receipt and the fanout transaction. */
  public async execute(input: DispatchAutomationTaskTriggerInput): Promise<void> {
    const { organizationId, job, signal } = input;
    signal.throwIfAborted();
    const { source } = job;
    if (source.trigger.actorType === 'automation') return;
    const fact = { ...source.trigger, organizationId };

    if (job.kind === 'action') {
      await this.action.execute(
        {
          organizationId,
          ruleId: job.ruleId,
          sourceEventId: source.id,
          taskKey: source.taskKey,
          fact,
        },
        signal,
      );
      return;
    }

    const { after } = job;
    const page = await this.rules.list(organizationId, {
      after: after === null ? null : { ...after, createdAt: new Date(after.createdAt) },
      limit: rulesPerPage,
    });
    const occurredAt = new Date(source.occurredAt);
    const next: AutomationTaskTriggerJob[] = [];
    for (const rule of page.items) {
      const state = rule.snapshot();
      if (state.createdAt > occurredAt) break;
      if (rule.matches(fact)) next.push({ kind: 'action', source, ruleId: state.ruleId });
    }
    if (page.next !== null && page.next.createdAt <= occurredAt) {
      next.push({
        kind: 'page',
        source,
        after: { createdAt: page.next.createdAt.toISOString(), ruleId: page.next.ruleId },
      });
    }
    if (next.length > 0) await this.jobs.enqueue(organizationId, next, signal);
  }
  // #endregion
}
