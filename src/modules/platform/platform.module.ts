import { Module } from '@nestjs/common';

import { PurgeIdempotencyReceipts } from './infrastructure/jobs/pg-boss/idempotency/purge-idempotency-receipts.adapter.js';

/**
 * Class PlatformModule
 *
 * @description
 * Owner, inside this service, of the tables the service kit stores in the service's own database:
 * the outbox, processed-ids and versions tables of `@cadenway/nest-messaging/outbox` and the
 * `Idempotency-Key` table of `@cadenway/nest-common/database`. Its persistence layer re-exports them
 * so that drizzle-kit, which reads `src/modules/<module>/infrastructure/persistence/*.schema.ts`
 * only, writes them into the migrations of the service.
 *
 * The kit reads and writes these tables. This module owns the local receipt retention schedule.
 * See its `MODULE.md`.
 */
@Module({ providers: [PurgeIdempotencyReceipts] })
export class PlatformModule {}
