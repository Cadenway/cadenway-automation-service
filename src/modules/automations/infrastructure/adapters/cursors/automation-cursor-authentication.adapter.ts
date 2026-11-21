import { createHmac, timingSafeEqual } from 'node:crypto';

import { ProblemException } from '@cadenway/nest-common';

const MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** Authenticates the opaque pagination state before it reaches the cursor decoder. */
export class AutomationCursorAuthentication {
  // #region Constructor
  /** Uses the deployment's dedicated 32-byte cursor key, when configured. */
  public constructor(private readonly key: Buffer | undefined) {}
  // #endregion

  // #region Methods
  /** Seals the transport cursor with a versioned MAC. */
  public sign(cursor: string): string {
    return `${cursor}.${this.tag(cursor).toString('base64url')}`;
  }

  /** Returns the original transport cursor only when its MAC matches. */
  public authenticate(cursor: string): string | undefined {
    const parts = cursor.split('.');
    const [payload, signature] = parts;
    if (parts.length !== 2 || !payload || !signature || !MAC_PATTERN.test(signature)) {
      return undefined;
    }
    const mac = Buffer.from(signature, 'base64url');
    return timingSafeEqual(mac, this.tag(payload)) ? payload : undefined;
  }

  /** Calculates the domain-separated tag without including the key in any error. */
  private tag(cursor: string): Buffer {
    if (this.key === undefined) {
      throw new ProblemException({ status: 503, code: 'automation.unavailable' });
    }
    return createHmac('sha256', this.key).update('automation-cursor-v1\0').update(cursor).digest();
  }
  // #endregion
}
