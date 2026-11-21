/** Database-allocated UUIDv7 and creation time for a new rule. */
export interface AutomationRuleIdentity {
  // #region Properties
  /** ruleId for this operation. */
  readonly ruleId: string;
  readonly createdAt: Date;
  // #endregion
}
