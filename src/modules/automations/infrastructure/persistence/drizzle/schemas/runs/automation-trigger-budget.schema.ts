import { sql } from 'drizzle-orm';
import { check, integer, pgPolicy, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Holds the latest admission window only, with no task, event or actor identifiers. */
export const automationTriggerBudget = pgTable(
  'automation_trigger_budget',
  {
    organizationId: uuid('organization_id').primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    queuedCount: integer('queued_count').notNull(),
  },
  (table) => [
    check('automation_trigger_budget_count_check', sql`${table.queuedCount} >= 0`),
    pgPolicy('automation_trigger_budget_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();
