# Automations

## Purpose

Owns organization-scoped rules and the history of their applied actions. Task owns task state and
task visibility. Notification owns notification delivery.

## Public entry points

None.

## Owned tables

- `automation_rules` owns immutable conditions, actions and the account that created each rule.
- `automation_runs` owns execution identities and action snapshots. Only applied runs appear in history.
- `automation_trigger_budget` keeps the latest admission window for each tenant, without storing
  event, task or actor identifiers.

The three tables use forced organization row-level security.

## API

The internal API registers five operations from the published OpenAPI contract.

| Method and path                            | Operation ID                          |
| ------------------------------------------ | ------------------------------------- |
| `GET /internal/v1/automations`             | `listAutomationRulesInternal`         |
| `POST /internal/v1/automations`            | `createAutomationRuleInternal`        |
| `PATCH /internal/v1/automations/{ruleId}`  | `updateAutomationRuleInternal`        |
| `DELETE /internal/v1/automations/{ruleId}` | `deleteAutomationRuleInternal`        |
| `GET /internal/v1/automation-runs`         | `listAutomationRunCandidatesInternal` |

The gateway must check current owner or administrator membership with Organization before calling
these operations. Automation checks the signed gateway issuer, service audience, user actor and
organization, then scopes every lookup and write to that tenant. Assignment and notification
rules require a signed proof of current recipient eligibility before creation or replay.

The internal history pages through a window of at most 100 recent applied actions. The
authenticated cursor binds the actor, organization, operation and window. The public history
requires the gateway to check each task's current visibility with Task as the requesting user and
return up to eight visible executions from that window.

## Events emitted

The outbox emits `evt.automation.executed.v1` only for a successfully applied action. Its actor
has type `automation` and its ID is the rule ID. Consumers deduplicate deliveries by event ID.

## Events consumed

When `AUTOMATION_TASK_TRIGGERS_ENABLED` is enabled, the service registers
`automation-service__run-task-created-rules` and `automation-service__run-task-status-changed-rules`
for the published `evt.task.created.v1` and `evt.task.status-changed.v1` subjects. First activation
starts at newly published events. Existing consumers retain their position. Activation is off by
default and requires the broker permissions and compatible downstream action endpoints. Setting
it to false pauses new reservations and fanout. Keep the Task URL and signing key configured
during a pause so the worker can settle reservations already committed to PostgreSQL.

Assignment and priority use the Task action endpoint.
`AUTOMATION_COMMENT_AND_NOTIFICATION_ACTIONS_ENABLED=true` enables new comment reservations
using only the Task transport. New notifications additionally need `NOTIFICATION_SERVICE_URL`.
Configure each owner's endpoint and issuer trust before admitting its actions. Keep the
Notification URL during a pause to allow settlement of reserved notifications. These actions
only enter history after an applied receipt. A suppressed in-app notification settles as a no-op.

Creating or enabling a comment or notification rule returns `503 automation.unavailable` while
these actions are disabled. The creation endpoint always creates an enabled rule and the patch
only changes enablement. Existing rules can be listed, disabled or deleted during the outage.
Workers skip unavailable actions when enqueuing or reserving new executions, including existing
rules left enabled. Already reserved actions keep their retry and reconciliation semantics.

Invalid events are dead-lettered in JetStream. A failing admission has five attempts with
delays of 1 second, 5 seconds, 30 seconds and 2 minutes. Queued work gets five attempts with
delays starting at 15 seconds and capped at 2 minutes. The worker checks the one-hour window
from the source fact at the start of each attempt, before contacting a downstream service.
The queue retains ready work for 48 hours so a resumed worker can record the expired attempt in
its dead-letter queue. Operators inspect failed work and reconcile the action with its owner
before retrying an ambiguous outcome. Work past the action window requires reconciliation
without an automatic replay.

## Invariants

- A rule matches creation or a transition to its configured status. Its single action assigns a
  user, changes priority, sends a notification or adds a comment.
- Events from an `automation` actor are ignored to prevent action-triggered loops. Disabled or
  deleted rules are ineligible for new trigger decisions. An unchanged enablement keeps the
  current rule version.
- Create and re-enable share a transaction lock and enforce a limit of 100 enabled rules per
  organization. A full organization can still disable or delete rules. API writes that would
  exceed this limit return the documented `503 automation.unavailable`. An unchanged enabled
  rule consumes no additional capacity.
- Each trigger scans at most the first 100 eligible rules ordered by creation time and ID.
  PostgreSQL filters candidates before applying the limit. Only rules already created when the
  fact occurred are eligible. Existing continuation jobs remain readable during rollout.
  Independent status transitions are evaluated by source event ID, regardless of arrival order.
- A tenant can add up to 256 jobs to the shared queue per minute. Each new fact outside this
  budget is skipped. The worker retries admitted fanout that hits the budget. An entire fanout
  commits or rolls back together. Replayed occurrences do not consume additional capacity.
  `automation.trigger.admission.rejected` counts rejected admission attempts by stage.
- Trigger work is limited to one concurrent job per organization across replicas. Each worker
  can process two jobs overall so a busy tenant group leaves capacity for another. Existing
  ungrouped jobs can use either slot until they finish or expire.
- The tenant, rule and triggering event identify one execution across retries. Only applied
  actions enter history and emit an execution fact. A no-op, skipped or failed action does not.
- A rule's delegation is recorded from the authenticated creator. The receiving service checks
  that this account still has the required authority before it applies an action.

## Transactions

The write use cases own the tenant transaction. Creating a rule uses the kit's
actor-and-tenant-scoped idempotency when the caller supplies a key. Enablement and deletion check
`If-Match`, when present, within the write transaction.

The broker deduplicator commits the event receipt and the initial fanout job together. A fanout
job commits the action jobs and queue budget together. Occurrence keys use the source
event ID plus the legacy page position or rule ID. An action worker reserves its execution identity in
its own transaction and uses that identity as the downstream idempotency key. The downstream
call runs outside PostgreSQL transactions. After the owner confirms it applied the action,
Automation commits the successful execution and its outbox row together.

## Decisions

- Under Decision A, Automation uses generated clients from published contracts for direct action
  commands to Task and Notification. It signs each call for the target service with the
  `automation` actor type and the lowercase rule UUID. The receiving service owns action authorization and
  its data writes.
- The gateway routes authorized reads. Task supplies current visibility for the public run
  history. Automation has no direct cross-service read path.
