import { describe, expect, it } from 'vitest';

import { AutomationCursorAuthentication } from './automation-cursor-authentication.adapter.js';

describe('automation cursor authentication', () => {
  it('binds the whole opaque cursor to its MAC and rejects malformed or tampered values', () => {
    const authentication = new AutomationCursorAuthentication(Buffer.alloc(32, 1));
    const cursor = authentication.sign('authorized-state');

    expect(authentication.authenticate(cursor)).toBe('authorized-state');
    expect(authentication.authenticate(cursor.replace('authorized-state', 'changed-state'))).toBe(
      undefined,
    );
    expect(authentication.authenticate(cursor + '.trailing')).toBe(undefined);
    expect(authentication.authenticate('authorized-state')).toBe(undefined);
    expect(new AutomationCursorAuthentication(Buffer.alloc(32, 2)).authenticate(cursor)).toBe(
      undefined,
    );
  });

  it('fails closed when the cursor key has not been configured', () => {
    const authentication = new AutomationCursorAuthentication(undefined);
    expect(() => authentication.sign('authorized-state')).toThrow('automation.unavailable');
  });
});
