import type { AutomationTriggerJobs } from '../../../../ports/outbound/jobs/runs/automation-trigger-jobs.port.js';
import type { AdmitAutomationTaskTriggerInput } from './admit-automation-task-trigger.input.js';

/** Reserves durable fanout for a Task fact without opening any external connection. */
export class AdmitAutomationTaskTrigger {
  // #region Constructor
  /** Binds the transaction-aware queue. */
  public constructor(private readonly jobs: AutomationTriggerJobs) {}
  // #endregion

  // #region Methods
  /** Ignores rule-generated events and commits one initial page for every other trigger. */
  public async execute(input: AdmitAutomationTaskTriggerInput): Promise<void> {
    const { organizationId, source, signal } = input;
    signal.throwIfAborted();
    if (source.trigger.actorType === 'automation') return;
    await this.jobs.enqueue(organizationId, [{ kind: 'page', source, after: null }], signal);
  }
  // #endregion
}
