import { decodeCursor, encodeCursor, ProblemException } from '@cadenway/nest-common';

import type { AutomationRunPageRequest } from '../../../../application/models/runs/automation-run-page-request.model.js';
import type { AutomationRunPosition } from '../../../../application/models/runs/automation-run-position.model.js';
import type { AutomationRulePosition } from '../../../../application/models/rules/automation-rule-position.model.js';

type CursorScope = Readonly<{ organizationId: string; actorId: string; operation: string }>;

/** Injection token for the service's authenticated cursor transport. */
export const AUTOMATION_CURSOR_AUTHENTICATION = Symbol('AUTOMATION_CURSOR_AUTHENTICATION');

/** Authenticates encoded cursors before their state is decoded. */
export interface CursorAuthentication {
  // #region Properties
  /** Seals the encoded state. */
  readonly sign: (cursor: string) => string;

  /** Returns the encoded state when authenticated. */
  readonly authenticate: (cursor: string) => string | undefined;
  // #endregion
}

const uuidV7 = /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;

function invalidCursor(): never {
  throw new ProblemException({
    status: 400,
    code: 'request.invalid',
    detail: 'The request does not match its contract.',
    details: { issues: [{ in: 'query', path: 'cursor', code: 'invalid_cursor' }] },
  });
}

function instant(value: unknown): Date {
  if (typeof value !== 'string') return invalidCursor();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return invalidCursor();
  return date;
}

/** Decodes a rule position scoped to the verified actor and organization. */
export function ruleCursor(cursor: string | undefined, scope: CursorScope): AutomationRulePosition {
  if (cursor === undefined) return invalidCursor();
  const position = decodeCursor(cursor, scope);
  if (position.sort.length !== 1 || !uuidV7.test(position.id)) return invalidCursor();
  return { createdAt: instant(position.sort[0]), ruleId: position.id };
}

/** Encodes an authorized rule-list continuation. */
export function encodeRuleCursor(position: AutomationRulePosition, scope: CursorScope): string {
  return encodeCursor({ sort: [position.createdAt.toISOString()], id: position.ruleId }, scope);
}

/** Decodes a bounded run-history window scoped to the verified actor and organization. */
export function runCursor(
  cursor: string | undefined,
  scope: CursorScope,
  limit: number,
): AutomationRunPageRequest {
  if (cursor === undefined) return invalidCursor();
  const position = decodeCursor(cursor, scope);
  const [upperAt, upperId, lastAt, remaining] = position.sort;
  if (
    position.sort.length !== 4 ||
    typeof upperId !== 'string' ||
    !uuidV7.test(upperId) ||
    !uuidV7.test(position.id) ||
    typeof remaining !== 'number' ||
    !Number.isInteger(remaining) ||
    remaining < 1 ||
    remaining > 99
  )
    return invalidCursor();
  const upper = { executedAt: instant(upperAt), id: upperId };
  const after = { executedAt: instant(lastAt), id: position.id };
  if (
    after.executedAt > upper.executedAt ||
    (after.executedAt.getTime() === upper.executedAt.getTime() && after.id > upper.id)
  )
    return invalidCursor();
  return { upper, after, remaining, limit };
}

/** Encodes the fixed upper bound, last item and remaining candidate budget. */
export function encodeRunCursor(
  upper: AutomationRunPosition,
  after: AutomationRunPosition,
  remaining: number,
  scope: CursorScope,
): string {
  return encodeCursor(
    {
      sort: [upper.executedAt.toISOString(), upper.id, after.executedAt.toISOString(), remaining],
      id: after.id,
    },
    scope,
  );
}
