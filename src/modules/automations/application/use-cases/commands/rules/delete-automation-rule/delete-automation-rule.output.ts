/** Deletion, absence, or the current version after a precondition failure. */
export type DeleteAutomationRuleOutput =
  | Readonly<{ status: 'deleted' }>
  | Readonly<{ status: 'not-found' }>
  | Readonly<{ status: 'version-mismatch'; version: number }>;
