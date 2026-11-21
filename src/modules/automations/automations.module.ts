import { PRIORITY_KEYS, STATUS_KEYS } from '@cadenway/contracts';
import {
  CONFIG,
  getOrganizationContext,
  InternalHttpClient,
  InternalTokenSigner,
} from '@cadenway/nest-common';
import { TenantTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import { JobProducer, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { EventConsumers } from '@cadenway/nest-messaging';
import { OutboxWriter } from '@cadenway/nest-messaging/outbox';
import { Module } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import { AUTOMATION_TASK_TRIGGER_QUEUE } from '../../config/job-queues.js';
import { AdmitAutomationTaskTrigger } from './application/use-cases/commands/runs/admit-automation-task-trigger/admit-automation-task-trigger.use-case.js';
import { DispatchAutomationTaskTrigger } from './application/use-cases/commands/runs/dispatch-automation-task-trigger/dispatch-automation-task-trigger.use-case.js';
import { ExecuteAutomationRule } from './application/use-cases/commands/runs/execute-automation-rule/execute-automation-rule.use-case.js';
import { CreateAutomationRule } from './application/use-cases/commands/rules/create-automation-rule/create-automation-rule.use-case.js';
import { DeleteAutomationRule } from './application/use-cases/commands/rules/delete-automation-rule/delete-automation-rule.use-case.js';
import { SetAutomationRuleEnabled } from './application/use-cases/commands/rules/set-automation-rule-enabled/set-automation-rule-enabled.use-case.js';
import { ListAutomationRules } from './application/use-cases/queries/rules/list-automation-rules/list-automation-rules.use-case.js';
import { ListAutomationRunCandidates } from './application/use-cases/queries/runs/list-automation-run-candidates/list-automation-run-candidates.use-case.js';
import { AutomationActionHttpAdapter } from './infrastructure/adapters/actions/automation-action-http.adapter.js';
import { AutomationCursorAuthentication } from './infrastructure/adapters/cursors/automation-cursor-authentication.adapter.js';
import { PgBossAutomationTriggerJobs } from './infrastructure/jobs/pg-boss/runs/pg-boss-automation-trigger-jobs.adapter.js';
import { AutomationExecutedOutbox } from './infrastructure/messaging/outbox/runs/automation-executed-outbox.adapter.js';
import { DrizzleAutomationRulesReader } from './infrastructure/persistence/drizzle/repositories/rules/drizzle-automation-rules.repository.js';
import { DrizzleAutomationRunsReader } from './infrastructure/persistence/drizzle/repositories/runs/drizzle-automation-runs.repository.js';
import { DrizzleAutomationRulesUnitOfWork } from './infrastructure/persistence/drizzle/transactions/rules/drizzle-automation-rules.unit-of-work.js';
import { DrizzleAutomationRunsUnitOfWork } from './infrastructure/persistence/drizzle/transactions/runs/drizzle-automation-runs.unit-of-work.js';
import { AutomationRunsController } from './presentation/http/controllers/automations/automation-runs.controller.js';
import { AutomationsController } from './presentation/http/controllers/automations/automations.controller.js';
import { AutomationRecipientGuard } from './presentation/http/guards/automations/automation-recipient.guard.js';
import { AUTOMATION_CURSOR_AUTHENTICATION } from './presentation/http/mappers/automations/automation-cursor.mapper.js';
import { AutomationTriggerJobHandler } from './presentation/jobs/handlers/runs/automation-trigger.handler.js';
import { TaskAutomationTriggerHandler } from './presentation/messaging/handlers/task/task-automation-trigger.handler.js';

const vocabulary = { statuses: STATUS_KEYS, priorities: PRIORITY_KEYS };

/** Composition boundary for organization-scoped automation rules and their execution history. */
@Module({
  controllers: [AutomationsController, AutomationRunsController],
  providers: [
    AutomationRecipientGuard,
    {
      provide: AUTOMATION_CURSOR_AUTHENTICATION,
      inject: [CONFIG],
      useFactory: (config: AppConfig) =>
        new AutomationCursorAuthentication(
          config.AUTOMATION_CURSOR_SIGNING_KEY === undefined
            ? undefined
            : Buffer.from(config.AUTOMATION_CURSOR_SIGNING_KEY, 'hex'),
        ),
    },
    {
      provide: DrizzleAutomationRulesUnitOfWork,
      inject: [TenantTransactionRunner],
      useFactory: (runner: TenantTransactionRunner<DatabaseSchema>) =>
        new DrizzleAutomationRulesUnitOfWork(runner, vocabulary),
    },
    {
      provide: ListAutomationRules,
      inject: [TenantTransactionRunner],
      useFactory: (runner: TenantTransactionRunner<DatabaseSchema>) =>
        new ListAutomationRules(new DrizzleAutomationRulesReader(runner, vocabulary)),
    },
    {
      provide: CreateAutomationRule,
      inject: [DrizzleAutomationRulesUnitOfWork],
      useFactory: (work: DrizzleAutomationRulesUnitOfWork) =>
        new CreateAutomationRule(work, vocabulary, {
          isActiveRecipient: (organizationId, userId) => {
            const caller = getOrganizationContext();
            return Promise.resolve(
              caller?.organizationId === organizationId &&
                caller.actor.type === 'user' &&
                caller.scopes.includes(`automation:recipient:${userId.toLowerCase()}`),
            );
          },
        }),
    },
    {
      provide: SetAutomationRuleEnabled,
      inject: [DrizzleAutomationRulesUnitOfWork],
      useFactory: (work: DrizzleAutomationRulesUnitOfWork) => new SetAutomationRuleEnabled(work),
    },
    {
      provide: DeleteAutomationRule,
      inject: [DrizzleAutomationRulesUnitOfWork],
      useFactory: (work: DrizzleAutomationRulesUnitOfWork) => new DeleteAutomationRule(work),
    },
    {
      provide: ListAutomationRunCandidates,
      inject: [TenantTransactionRunner],
      useFactory: (runner: TenantTransactionRunner<DatabaseSchema>) =>
        new ListAutomationRunCandidates(new DrizzleAutomationRunsReader(runner)),
    },
    {
      provide: PgBossAutomationTriggerJobs,
      inject: [TenantTransactionRunner, JobProducer],
      useFactory: (runner: TenantTransactionRunner<DatabaseSchema>, producer: JobProducer) =>
        new PgBossAutomationTriggerJobs(runner, producer),
    },
    {
      provide: TaskAutomationTriggerHandler,
      inject: [CONFIG, EventConsumers, PgBossAutomationTriggerJobs],
      useFactory: (
        config: AppConfig,
        consumers: EventConsumers,
        jobs: PgBossAutomationTriggerJobs,
      ) =>
        config.AUTOMATION_TASK_TRIGGERS_ENABLED
          ? new TaskAutomationTriggerHandler(consumers, new AdmitAutomationTaskTrigger(jobs))
          : null,
    },
    {
      provide: AutomationTriggerJobHandler,
      inject: [
        CONFIG,
        JobWorkerRegistry,
        TenantTransactionRunner,
        OutboxWriter,
        PgBossAutomationTriggerJobs,
      ],
      useFactory: async (
        config: AppConfig,
        workers: JobWorkerRegistry,
        runner: TenantTransactionRunner<DatabaseSchema>,
        outboxWriter: OutboxWriter,
        jobs: PgBossAutomationTriggerJobs,
      ) => {
        if (!config.AUTOMATION_TASK_TRIGGERS_ENABLED) return null;
        const privateJwk = config.INTERNAL_TOKEN_PRIVATE_JWK;
        const baseUrl = config.TASK_SERVICE_URL;
        if (privateJwk === undefined || baseUrl === undefined) {
          throw new Error('The Task action transport is not configured.');
        }
        const signer = await InternalTokenSigner.create({
          issuer: config.INTERNAL_TOKEN_ISSUER,
          privateJwk,
        });
        const notificationUrl = config.AUTOMATION_COMMENT_AND_NOTIFICATION_ACTIONS_ENABLED
          ? config.NOTIFICATION_SERVICE_URL
          : undefined;
        const actions = new AutomationActionHttpAdapter(
          new InternalHttpClient({
            service: 'task-service',
            baseUrl,
            signer,
            allowedUnavailableProblemCodes: ['task.action-unavailable'],
          }),
          notificationUrl === undefined
            ? undefined
            : new InternalHttpClient({
                service: 'notification-service',
                baseUrl: notificationUrl,
                signer,
                allowedUnavailableProblemCodes: ['upstream.unavailable'],
              }),
        );
        const outbox = new AutomationExecutedOutbox(outboxWriter);
        const work = new DrizzleAutomationRunsUnitOfWork(runner, vocabulary, (scope, run) =>
          outbox.append(scope, run),
        );
        const dispatch = new DispatchAutomationTaskTrigger(
          new DrizzleAutomationRulesReader(runner, vocabulary),
          jobs,
          new ExecuteAutomationRule(work, actions),
        );
        return new AutomationTriggerJobHandler(
          workers,
          dispatch,
          AUTOMATION_TASK_TRIGGER_QUEUE.name,
        );
      },
    },
  ],
})
export class AutomationsModule {}
