/** Verifies current recipient eligibility established at the authorized service boundary. */
export interface AutomationRecipientAuthority {
  // #region Properties
  /** isActiveRecipient for this operation. */
  readonly isActiveRecipient: (organizationId: string, userId: string) => Promise<boolean>;
  // #endregion
}
