import {
  baseConfigShape,
  internalTokenSignerConfigShape,
  internalTokenVerifierConfigShape,
} from '@cadenway/nest-common';
import type {
  BaseConfig,
  InternalTokenSignerConfig,
  InternalTokenVerifierConfig,
} from '@cadenway/nest-common';
import { databaseConfigShape } from '@cadenway/nest-common/database';
import type { DatabaseConfig } from '@cadenway/nest-common/database';
import { messagingConfigShape } from '@cadenway/nest-messaging';
import type { MessagingConfig } from '@cadenway/nest-messaging';
import { z } from 'zod';

/**
 * Type AppConfig
 *
 * @description
 * Variables the running service reads, validated when the application is created: by `loadConfig`
 * in `main.ts` for the options of `createApplication`, and by `ConfigModule` for the providers that
 * inject `CONFIG`.
 *
 * - `NODE_ENV`, `PORT`, `LOG_LEVEL`, `LOG_PRETTY`: `baseConfigShape` of `@cadenway/nest-common`;
 *   `PORT` is required, the others default to `production`, `info` and `false`.
 * - `DATABASE_URL`: the application role of this service's own database (`automation_app`),
 *   subject to row-level security and holding no DDL right.
 * - `DATABASE_TRANSACTION_MAX_ATTEMPTS`: total attempts for retryable PostgreSQL transactions,
 *   defaulting to 3. Use 1 to disable retries.
 * - `NATS_URL`, `NATS_USER`, `NATS_PASSWORD`: `messagingConfigShape` of `@cadenway/nest-messaging`.
 *   `NATS_URL` is required; the user (`automation`) and its password are optional for the kit,
 *   which accepts an anonymous local broker, but every broker of Cadenway refuses a connection
 *   without them.
 * - `INTERNAL_TOKEN_AUDIENCE` and `INTERNAL_TOKEN_TRUSTED_ISSUERS`: the `aud` this service accepts
 *   and the public keys of the backends allowed to call it.
 * - `AUTOMATION_CURSOR_SIGNING_KEY`: dedicated 32-byte hexadecimal key for authenticated
 *   pagination. Continuations require this key.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is read by `telemetry.ts`, before the application exists.
 * `AUTOMATION_TASK_TRIGGERS_ENABLED` starts the Task subscriptions and job worker. It is off
 * until both Task and the broker permissions are available. Enabling it requires the Automation
 * signing key and `TASK_SERVICE_URL`.
 * `AUTOMATION_COMMENT_AND_NOTIFICATION_ACTIONS_ENABLED` starts dispatching these two action
 * types once both owners are available. It requires Task triggers and `NOTIFICATION_SERVICE_URL`.
 *
 * @type {BaseConfig & DatabaseConfig & MessagingConfig & InternalTokenVerifierConfig}
 */
export type AppConfig = BaseConfig &
  DatabaseConfig &
  MessagingConfig &
  InternalTokenVerifierConfig &
  Pick<InternalTokenSignerConfig, 'INTERNAL_TOKEN_ISSUER'> & {
    readonly AUTOMATION_CURSOR_SIGNING_KEY?: string | undefined;
    readonly AUTOMATION_TASK_TRIGGERS_ENABLED: boolean;
    readonly AUTOMATION_COMMENT_AND_NOTIFICATION_ACTIONS_ENABLED: boolean;
    readonly INTERNAL_TOKEN_PRIVATE_JWK?:
      InternalTokenSignerConfig['INTERNAL_TOKEN_PRIVATE_JWK'] | undefined;
    readonly TASK_SERVICE_URL?: string | undefined;
    readonly NOTIFICATION_SERVICE_URL?: string | undefined;
  };

/**
 * Constant appConfigSchema
 *
 * @description
 * Zod schema of `AppConfig`, composed from the shapes of `@cadenway/nest-common` and
 * `@cadenway/nest-messaging` so the names, defaults and validation stay those of the kit. A missing
 * or invalid variable makes `loadConfig` throw a `ConfigError` that names it without printing its
 * value.
 *
 * @type {z.ZodType<AppConfig>}
 */
export const appConfigSchema: z.ZodType<AppConfig> = z
  .object({
    ...baseConfigShape,
    ...databaseConfigShape,
    ...messagingConfigShape,
    ...internalTokenVerifierConfigShape,
    INTERNAL_TOKEN_ISSUER: z.literal('automation-service').default('automation-service'),
    INTERNAL_TOKEN_PRIVATE_JWK:
      internalTokenSignerConfigShape.INTERNAL_TOKEN_PRIVATE_JWK.optional(),
    TASK_SERVICE_URL: z.url({ protocol: /^https?$/u }).optional(),
    NOTIFICATION_SERVICE_URL: z
      .union([z.url({ protocol: /^https?$/u }), z.literal('')])
      .transform((value) => value || undefined)
      .optional(),
    AUTOMATION_TASK_TRIGGERS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    AUTOMATION_COMMENT_AND_NOTIFICATION_ACTIONS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    AUTOMATION_CURSOR_SIGNING_KEY: z
      .string()
      .regex(/^[\da-f]{64}$/iu)
      .optional(),
  })
  .superRefine((config, ctx) => {
    if (config.AUTOMATION_COMMENT_AND_NOTIFICATION_ACTIONS_ENABLED) {
      if (!config.AUTOMATION_TASK_TRIGGERS_ENABLED) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTOMATION_TASK_TRIGGERS_ENABLED'],
          message: 'Task triggers must be enabled for comment and notification actions.',
        });
      }
      if (config.NOTIFICATION_SERVICE_URL === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['NOTIFICATION_SERVICE_URL'],
          message: 'Required for automation notification actions.',
        });
      }
    }
    if (!config.AUTOMATION_TASK_TRIGGERS_ENABLED) return;
    for (const name of ['INTERNAL_TOKEN_PRIVATE_JWK', 'TASK_SERVICE_URL'] as const) {
      if (config[name] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'Required for Task-triggered actions.',
        });
      }
    }
  });

/**
 * Interface MigrationConfig
 *
 * @description
 * Variable the one-off migration container reads (`node dist/migrate.js`). The running service
 * never reads it: only the migrator role may change the structure of the database.
 */
export interface MigrationConfig {
  // #region Properties
  /**
   * Property MIGRATION_DATABASE_URL
   *
   * @description
   * Connection string of the migrator role (`automation_migrator`), which owns the tables and runs
   * the DDL. A secret; cadenway-ops passes it from `AUTOMATION_SERVICE_MIGRATION_DATABASE_URL`.
   *
   * @type {string}
   * @readonly
   */
  readonly MIGRATION_DATABASE_URL: string;
  // #endregion
}

/**
 * Constant migrationConfigSchema
 *
 * @description
 * Zod schema of `MigrationConfig`: a `postgres://` or `postgresql://` URL, like `DATABASE_URL`.
 *
 * @type {z.ZodType<MigrationConfig>}
 */
export const migrationConfigSchema: z.ZodType<MigrationConfig> = z.object({
  MIGRATION_DATABASE_URL: z.url({
    protocol: /^postgres(?:ql)?$/u,
    error: 'Expected the postgres:// URL of the migrator role.',
  }),
});
