/** Stable ordering key for an applied automation execution. */
export interface AutomationRunPosition {
  // #region Properties
  /** Time when the action was applied. */
  readonly executedAt: Date;

  /** Identity disambiguating executions at the same instant. */
  readonly id: string;
  // #endregion
}
