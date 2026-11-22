import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '@cadenway/nest-common';
import { provisionJobs } from '@cadenway/nest-jobs/provisioning';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { migrationConfigSchema } from './config/app-config.js';
import type { MigrationConfig } from './config/app-config.js';
import { jobQueues } from './config/job-queues.js';

// Entry point of the one-off migration container (`node dist/migrate.js`), which the GitOps agent of
// cadenway-ops runs before it starts a new version. drizzle-kit is a development dependency and is
// not in the production image, so the migrations are applied with the runtime migrator.
//
// They run as the migrator role of MIGRATION_DATABASE_URL, which owns the tables: the application
// role of DATABASE_URL holds no DDL right and would be refused. The variable is validated only when
// there is something to apply, and a missing or malformed one stops the container with a
// ConfigError that names it.
/**
 * Constant migrationsFolder
 *
 * @description
 * Location of the migration files included in the service image.
 *
 * @type {string}
 */
const migrationsFolder: string = fileURLToPath(new URL('../migrations', import.meta.url));

const enabledRulesIndex = 'automation_rules_enabled_organization_created_id_index';
const enabledRulesDefinition = `CREATE INDEX ${enabledRulesIndex} ON public.automation_rules USING btree (organization_id, created_at, id) WHERE enabled`;

async function readEnabledRulesIndex(client: pg.Client) {
  const { rows } = await client.query<{
    readonly tableExists: boolean;
    readonly indexExists: boolean;
    readonly definition: string | null;
    readonly usable: boolean | null;
  }>(
    `select to_regclass('public.automation_rules') is not null as "tableExists",
            existing.oid is not null as "indexExists",
            pg_get_indexdef(idx.indexrelid) as definition,
            idx.indisvalid and idx.indisready and idx.indislive as usable
       from (select to_regclass($1) as oid) as existing
       left join pg_index as idx on idx.indexrelid = existing.oid`,
    [`public.${enabledRulesIndex}`],
  );
  const index = rows[0];
  if (index === undefined) throw new Error('Could not inspect the active automation rules index.');
  return index;
}

/** Prepares the live index without blocking rule writes. Fresh databases use the Drizzle DDL. */
async function prepareEnabledRulesIndex(client: pg.Client): Promise<void> {
  const index = await readEnabledRulesIndex(client);
  if (index.indexExists && index.definition !== enabledRulesDefinition) {
    throw new Error('The existing active automation rules index has an unexpected definition.');
  }
  if (!index.tableExists || index.usable === true) return;

  const ddl = readFileSync(
    new URL('../migrations/0004_automation_enabled_rules_lookup.sql', import.meta.url),
    'utf8',
  ).trim();
  const prefix = `CREATE INDEX IF NOT EXISTS "${enabledRulesIndex}" ON "automation_rules" `;
  if (!ddl.startsWith(prefix) || !/^[^;]+;$/u.test(ddl)) {
    throw new Error(
      'The active automation rules migration must contain one index creation statement.',
    );
  }
  if (index.indexExists) {
    await client.query(`DROP INDEX CONCURRENTLY public.${enabledRulesIndex}`);
  }
  await client.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${enabledRulesIndex}" ON public.automation_rules ${ddl.slice(prefix.length)}`,
  );
  const built = await readEnabledRulesIndex(client);
  if (built.usable !== true || built.definition !== enabledRulesDefinition) {
    throw new Error('Could not prepare the expected active automation rules index.');
  }
}

if (!existsSync(`${migrationsFolder}/meta/_journal.json`)) {
  console.log('No migration has been generated yet: nothing to apply.');
} else {
  const migration: Readonly<MigrationConfig> = loadConfig(migrationConfigSchema);
  const client: pg.Client = new pg.Client({
    connectionString: migration.MIGRATION_DATABASE_URL,
    application_name: 'automation-service-migrator',
  });
  try {
    await client.connect();
    await client.query(
      "select pg_advisory_lock(hashtextextended('automation-service:migrations', 0))",
    );
    await prepareEnabledRulesIndex(client);
    await migrate(drizzle({ client }), { migrationsFolder });
    console.log('Migrations applied.');
  } finally {
    await client.end();
  }
  await provisionJobs({
    connection: { connectionString: migration.MIGRATION_DATABASE_URL },
    appRole: 'automation_app',
    queues: jobQueues,
  });
}
