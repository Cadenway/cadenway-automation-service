import { idempotencyKeys, SystemTransactionRunner } from '@cadenway/nest-common/database';
import { JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { inArray, lte, sql } from 'drizzle-orm';

import { AUTOMATION_PURGE_RECEIPTS_QUEUE } from '../../../../../../config/job-queues.js';

const batchSize = 500;

/** Removes expired Automation API receipts without holding unbounded row locks. */
@Injectable()
export class PurgeIdempotencyReceipts implements OnApplicationBootstrap {
  // #region Constructor
  /** Binds the scheduled worker to its system transaction runner. */
  public constructor(
    private readonly system: SystemTransactionRunner,
    private readonly scheduler: JobScheduler,
    private readonly workers: JobWorkerRegistry,
  ) {}
  // #endregion

  // #region Methods
  /** Provisions one shared schedule and a local worker after JobsRuntimeModule starts. */
  public async onApplicationBootstrap(): Promise<void> {
    const queue = AUTOMATION_PURGE_RECEIPTS_QUEUE.name;
    await this.scheduler.schedule(queue, '* * * * *', { timeZone: 'UTC', key: 'minutely' });
    await this.workers.work(queue, async ({ organizationId, signal }) => {
      if (organizationId !== null)
        throw new Error('Automation receipt maintenance requires system scope.');
      signal.throwIfAborted();
      await this.system.run(async ({ db }) => {
        const expired = lte(idempotencyKeys.expiresAt, sql`statement_timestamp()`);
        const candidates = db
          .select({ id: idempotencyKeys.id })
          .from(idempotencyKeys)
          .where(expired)
          .orderBy(idempotencyKeys.expiresAt, idempotencyKeys.id)
          .limit(batchSize)
          .for('update', { skipLocked: true });
        await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.id, candidates));
      });
    });
  }
  // #endregion
}
