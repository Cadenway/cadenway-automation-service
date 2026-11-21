type TaskFactOrigin = Readonly<{
  organizationId: string;
  actorType: 'user' | 'automation' | 'git' | 'system';
}>;

/** The task fact fields needed to decide rule eligibility, independent of the event envelope. */
export type AutomationTriggerFact = TaskFactOrigin &
  (
    | Readonly<{ type: 'created' }>
    | Readonly<{ type: 'status'; previousStatus: string; status: string }>
  );
