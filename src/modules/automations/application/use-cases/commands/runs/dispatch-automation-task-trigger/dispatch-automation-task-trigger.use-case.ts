import { maxEnabledAutomationRules } from '../../../../../domain/policies/rules/automation-rule-capacity.policy.js';
import type { AutomationAction } from '../../../../../domain/value-objects/rules/automation-action.value-object.js';
import type { AutomationTaskTriggerJob } from '../../../../models/runs/automation-task-trigger-job.model.js';
import type { AutomationTriggerJobs } from '../../../../ports/outbound/jobs/runs/automation-trigger-jobs.port.js';
import type { AutomationTriggerRulesReader } from '../../../../ports/outbound/persistence/rules/automation-trigger-rules-reader.port.js';
import type { ExecuteAutomationRule } from '../execute-automation-rule/execute-automation-rule.use-case.js';
import type { DispatchAutomationTaskTriggerInput } from './dispatch-automation-task-trigger.input.js';

/** Dispatches a bounded fanout or one independently retryable action. */
export class DispatchAutomationTaskTrigger {
  // #region Constructor
  /** Binds the queue and action command with the admission policy for this worker. */
  public constructor(
    private readonly rules: AutomationTriggerRulesReader,
    private readonly jobs: AutomationTriggerJobs,
    private readonly action: Pick<ExecuteAutomationRule, 'execute'>,
    private readonly availableActions: readonly AutomationAction['type'][],
    private readonly admissionEnabled: boolean,
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
          allowNewReservation: this.admissionEnabled,
        },
        signal,
      );
      return;
    }

    if (!this.admissionEnabled) return;
    if (fact.type === 'status' && fact.previousStatus === fact.status) return;
    const { after } = job;
    const page = await this.rules.listTriggerCandidates(organizationId, {
      after: after === null ? null : { ...after, createdAt: new Date(after.createdAt) },
      limit: maxEnabledAutomationRules,
      occurredAt: new Date(source.occurredAt),
      trigger:
        fact.type === 'created' ? { type: 'created' } : { type: 'status', status: fact.status },
      availableActions: this.availableActions,
    });
    const next: AutomationTaskTriggerJob[] = [];
    for (const rule of page.items) {
      if (rule.matches(fact)) {
        next.push({ kind: 'action', source, ruleId: rule.snapshot().ruleId });
      }
    }
    // Preserve reads from already queued continuation cursors, but do not create new ones.
    // This also bounds work from tenants that had more rules than the current write limit.
    if (next.length > 0) await this.jobs.enqueue(organizationId, next, signal);
  }
  // #endregion
}
