import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { AutomationAction } from '../../../../../domain/value-objects/rules/automation-action.value-object.js';

/** Durable, tenant-scoped execution intents and their applied-action history. */
export const automationRuns = pgTable(
  'automation_runs',
  {
    organizationId: uuid('organization_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    ruleId: uuid('rule_id').notNull(),
    ruleAuthorUserId: uuid('rule_author_user_id').notNull(),
    sourceEventId: uuid('source_event_id').notNull(),
    taskKey: text('task_key').notNull(),
    action: jsonb('action').$type<AutomationAction>().notNull(),
    status: text('status').$type<'pending' | 'applied' | 'no_op'>().notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    executedAt: timestamp('executed_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    uniqueIndex('automation_runs_organization_rule_event_unique').on(
      table.organizationId,
      table.ruleId,
      table.sourceEventId,
    ),
    index('automation_runs_organization_executed_id_index')
      .on(table.organizationId, table.executedAt.desc(), table.id.desc())
      .where(sql`${table.status} = 'applied'`),
    check('automation_runs_action_object_check', sql`jsonb_typeof(${table.action}) = 'object'`),
    check('automation_runs_status_check', sql`${table.status} in ('pending', 'applied', 'no_op')`),
    check(
      'automation_runs_execution_time_check',
      sql`(${table.status} = 'applied') = (${table.executedAt} is not null)`,
    ),
    pgPolicy('automation_runs_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();
