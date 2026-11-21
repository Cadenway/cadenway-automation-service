/** The requested enabled state and optional version from the verified request. */
export interface SetAutomationRuleEnabledInput {
  // #region Properties
  /** organizationId for this operation. */
  readonly organizationId: string;
  readonly ruleId: string;
  readonly enabled: boolean;
  readonly expectedVersion: number | null;
  // #endregion
}
