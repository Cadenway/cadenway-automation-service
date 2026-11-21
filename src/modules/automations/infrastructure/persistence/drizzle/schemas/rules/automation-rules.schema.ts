import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import type { AutomationAction } from '../../../../../domain/value-objects/rules/automation-action.value-object.js';
import type { AutomationTrigger } from '../../../../../domain/value-objects/rules/automation-trigger.value-object.js';

/** The immutable condition and effect of an organization's automation rule. */
export const automationRules = pgTable(
  'automation_rules',
  {
    organizationId: uuid('organization_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    trigger: jsonb('trigger').$type<AutomationTrigger>().notNull(),
    action: jsonb('action').$type<AutomationAction>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    index('automation_rules_organization_created_id_index').on(
      table.organizationId,
      table.createdAt,
      table.id,
    ),
    check('automation_rules_version_check', sql`${table.version} between 1 and 9007199254740991`),
    check('automation_rules_trigger_object_check', sql`jsonb_typeof(${table.trigger}) = 'object'`),
    check('automation_rules_action_object_check', sql`jsonb_typeof(${table.action}) = 'object'`),
    pgPolicy('automation_rules_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();
