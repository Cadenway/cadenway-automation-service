/** Outcome of processing one event for one rule. */
export type ExecuteAutomationRuleOutput =
  Readonly<{ status: 'ignored' }> | Readonly<{ status: 'applied' | 'no_op'; runId: string }>;
