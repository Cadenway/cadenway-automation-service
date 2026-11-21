/** Task vocabulary supplied by the service boundary when it creates or restores a rule. */
export interface AutomationTaskVocabulary {
  // #region Properties
  /** Status keys available for the Automation trigger. */
  readonly statuses: readonly string[];

  /** Priority keys available for the Automation action. */
  readonly priorities: readonly string[];
  // #endregion
}
