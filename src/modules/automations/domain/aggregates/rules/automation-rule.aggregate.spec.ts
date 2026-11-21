import { describe, expect, it } from 'vitest';

import { AutomationRuleError } from '../../errors/rules/automation-rule.error.js';
import type { AutomationAction } from '../../value-objects/rules/automation-action.value-object.js';
import type { AutomationRuleState } from '../../value-objects/rules/automation-rule-state.value-object.js';
import type { AutomationTriggerFact } from '../../value-objects/rules/automation-trigger-fact.value-object.js';
import { AutomationRule } from './automation-rule.aggregate.js';

const atelierNord = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const anotherOrganization = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b31';
const camille = '019a5f3c-a0b1-7c2d-9e3f-5a6b7c8d9e32';

const definition = {
  ruleId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01',
  organizationId: atelierNord,
  ruleAuthorUserId: camille,
  trigger: { type: 'created' },
  action: { type: 'assign', userId: camille },
  createdAt: new Date('2026-11-20T08:00:00Z'),
} satisfies Omit<AutomationRuleState, 'enabled' | 'version'>;

const creation = {
  type: 'created',
  organizationId: atelierNord,
  actorType: 'user',
} satisfies AutomationTriggerFact;

const statusChange = {
  type: 'status',
  previousStatus: 'progress',
  status: 'review',
  organizationId: atelierNord,
  actorType: 'git',
} satisfies AutomationTriggerFact;

const vocabulary = {
  statuses: ['progress', 'review', 'done'],
  priorities: ['urgente', 'moyenne'],
};

function createRule(input: Omit<AutomationRuleState, 'enabled' | 'version'>): AutomationRule {
  return AutomationRule.create(input, vocabulary);
}

function restoreRule(state: AutomationRuleState): AutomationRule {
  return AutomationRule.restore(state, vocabulary);
}

describe('AutomationRule', () => {
  it('starts enabled at version one', () => {
    expect(createRule(definition).snapshot()).toEqual({
      ...definition,
      enabled: true,
      version: 1,
    });
  });

  it('keeps the authenticated author as a canonical account UUIDv7', () => {
    const uppercaseAuthor = camille.toUpperCase();
    expect(
      createRule({ ...definition, ruleAuthorUserId: uppercaseAuthor }).snapshot(),
    ).toMatchObject({
      ruleAuthorUserId: camille,
    });
    expect(() => createRule({ ...definition, ruleAuthorUserId: 'provenance-free' })).toThrow(
      'invalid-rule-author',
    );
  });

  it('preserves a stored rule and advances only on a different enabled value', () => {
    const rule = restoreRule({ ...definition, enabled: false, version: 3 });
    const enabled = rule.setEnabled(true);

    expect(rule.snapshot()).toMatchObject({ enabled: false, version: 3 });
    expect(rule.setEnabled(false)).toBe(rule);
    expect(enabled.snapshot()).toMatchObject({ enabled: true, version: 4 });
    expect(enabled.setEnabled(true)).toBe(enabled);
    expect(enabled.setEnabled(false).snapshot()).toMatchObject({ enabled: false, version: 5 });
  });

  it('owns immutable trigger and action values and copies the supplied timestamp', () => {
    const action: { type: 'assign'; userId: string } = { type: 'assign', userId: camille };
    const trigger: { type: 'status'; status: 'review' | 'done' } = {
      type: 'status',
      status: 'review',
    };
    const createdAt = new Date(definition.createdAt);
    const rule = createRule({ ...definition, action, trigger, createdAt });

    action.userId = definition.ruleId;
    trigger.status = 'done';
    createdAt.setUTCFullYear(2000);
    rule.snapshot().createdAt.setUTCFullYear(2001);

    expect(rule.snapshot()).toEqual({
      ...definition,
      action: { type: 'assign', userId: camille },
      trigger: { type: 'status', status: 'review' },
      enabled: true,
      version: 1,
    });
  });

  it('matches creation without treating it as a status change', () => {
    const creationRule = createRule(definition);
    const statusRule = createRule({
      ...definition,
      trigger: { type: 'status', status: 'review' },
    });

    expect(creationRule.matches(creation)).toBe(true);
    expect(creationRule.matches(statusChange)).toBe(false);
    expect(statusRule.matches(creation)).toBe(false);
  });

  it('matches a Git status transition only when it enters the configured status', () => {
    const rule = createRule({
      ...definition,
      trigger: { type: 'status', status: 'review' },
    });

    expect(rule.matches(statusChange)).toBe(true);
    expect(rule.matches({ ...statusChange, status: 'done' })).toBe(false);
    expect(rule.matches({ ...statusChange, previousStatus: 'review' })).toBe(false);
  });

  it('ignores both types of automation-originated task facts', () => {
    const creationRule = createRule(definition);
    const statusRule = createRule({
      ...definition,
      trigger: { type: 'status', status: 'review' },
    });

    expect(creationRule.matches({ ...creation, actorType: 'automation' })).toBe(false);
    expect(statusRule.matches({ ...statusChange, actorType: 'automation' })).toBe(false);
  });

  it('ignores facts for another organization and when the rule is disabled', () => {
    const rule = createRule(definition);

    expect(rule.matches({ ...creation, organizationId: anotherOrganization })).toBe(false);
    expect(rule.setEnabled(false).matches(creation)).toBe(false);
  });

  it.each([
    { type: 'assign', userId: camille },
    { type: 'priority', priority: 'urgente' },
    { type: 'notify', userId: camille },
    { type: 'comment', body: '  **Sprint 14**\nCAD-482  ' },
  ] satisfies AutomationAction[])('keeps the payload of a $type action', (action) => {
    expect(createRule({ ...definition, action }).snapshot().action).toEqual(action);
  });

  it('counts comment length in Unicode code points and keeps the original body', () => {
    const body = '🧪'.repeat(5_000);
    const comment = { type: 'comment', body } as const;

    expect(createRule({ ...definition, action: comment }).snapshot().action).toEqual(comment);
    expect(() => createRule({ ...definition, action: { ...comment, body: body + '🧪' } })).toThrow(
      AutomationRuleError,
    );
  });

  it.each([
    { type: 'comment', body: ' \t\n' },
    { type: 'notify', userId: 'missing-user' },
    { type: 'assign', userId: '' },
  ] satisfies AutomationAction[])(
    'refuses an invalid $type action with a domain error',
    (action) => {
      expect(() => createRule({ ...definition, action })).toThrow(AutomationRuleError);
    },
  );

  it('refuses an unknown task status or priority read from old data', () => {
    const trigger = { type: 'status', status: 'imagined-status' } as const;
    const action = { type: 'priority', priority: 'imagined-priority' } as const;

    expect(() => createRule({ ...definition, trigger })).toThrow(AutomationRuleError);
    expect(() => createRule({ ...definition, action })).toThrow(AutomationRuleError);
  });

  it('refuses an invalid identity, timestamp or persisted version', () => {
    expect(() => createRule({ ...definition, ruleId: 'invalid' })).toThrow(AutomationRuleError);
    expect(() => createRule({ ...definition, organizationId: '' })).toThrow(AutomationRuleError);
    expect(() => createRule({ ...definition, createdAt: new Date(NaN) })).toThrow(
      AutomationRuleError,
    );
    expect(() => restoreRule({ ...definition, enabled: true, version: 0 })).toThrow(
      AutomationRuleError,
    );
    expect(() =>
      restoreRule({
        ...definition,
        enabled: true,
        version: Number.MAX_SAFE_INTEGER,
      }).setEnabled(false),
    ).toThrow(AutomationRuleError);
  });
});
