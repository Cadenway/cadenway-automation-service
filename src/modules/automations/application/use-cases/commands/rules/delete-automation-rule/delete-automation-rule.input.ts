/** The rule identity, trusted tenant, and optional version precondition. */
export interface DeleteAutomationRuleInput {
  // #region Properties
  /** organizationId for this operation. */
  readonly organizationId: string;
  readonly ruleId: string;
  readonly expectedVersion: number | null;
  // #endregion
}
