abstract class DomainError extends Error {}

type RuleRefusal =
  | 'invalid-rule-id'
  | 'invalid-organization-id'
  | 'invalid-rule-author'
  | 'invalid-creation-time'
  | 'invalid-version'
  | 'invalid-trigger'
  | 'invalid-status'
  | 'invalid-action'
  | 'invalid-recipient'
  | 'invalid-priority'
  | 'invalid-comment';

/** Identifies invalid Automation rule data without including the supplied value in the error. */
export class AutomationRuleError extends DomainError {
  // #region Properties
  /** The domain error's stable class name. */
  public override readonly name = 'AutomationRuleError';
  // #endregion

  // #region Constructor
  /** Carries the refusal reason for the caller that translates it. */
  public constructor(public readonly reason: RuleRefusal) {
    super(`Invalid automation rule (${reason}).`);
  }
  // #endregion
}
