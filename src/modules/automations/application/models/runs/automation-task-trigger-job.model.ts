import type { AutomationTriggerFact } from '../../../domain/value-objects/rules/automation-trigger-fact.value-object.js';

type SourceEvent = Readonly<{
  id: string;
  occurredAt: string;
  taskKey: string;
  trigger:
    | Omit<Extract<AutomationTriggerFact, { readonly type: 'created' }>, 'organizationId'>
    | Omit<Extract<AutomationTriggerFact, { readonly type: 'status' }>, 'organizationId'>;
}>;

/** Bounded work for an admitted Task event, with the tenant supplied by the job envelope. */
export type AutomationTaskTriggerJob = Readonly<{ source: SourceEvent }> &
  (
    | Readonly<{
        kind: 'page';
        after: Readonly<{ createdAt: string; ruleId: string }> | null;
      }>
    | Readonly<{ kind: 'action'; ruleId: string }>
  );
