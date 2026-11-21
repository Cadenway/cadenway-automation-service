# Automations

## Purpose

Owns organization-scoped rules and the history of their applied actions. Task owns task state and
task visibility. Notification owns notification delivery.

## Public entry points

None.

## Owned tables

- `automation_rules` owns immutable conditions, actions and the account that created each rule.
- `automation_runs` owns execution identities and action snapshots. Only applied runs appear in history.

Both tables use forced organization row-level security.

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
default and requires the broker permissions and compatible downstream action endpoints.

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
- A continuation advances through the tenant's rules by creation time and ID in pages of up to 32. Only rules already created when the fact occurred are eligible. Independent status
  transitions are evaluated by source event ID, regardless of arrival order.
- The tenant, rule and triggering event identify one execution across retries. Only applied
  actions enter history and emit an execution fact. A no-op, skipped or failed action does not.
- A rule's delegation is recorded from the authenticated creator. The receiving service checks
  that this account still has the required authority before it applies an action.

## Transactions

The write use cases own the tenant transaction. Creating a rule uses the kit's
actor-and-tenant-scoped idempotency when the caller supplies a key. Enablement and deletion check
`If-Match`, when present, within the write transaction.

The broker deduplicator commits the event receipt and the initial fanout job together. A fanout
job commits the page's action jobs and continuation together. Occurrence keys use the source
event ID plus the page position or rule ID. An action worker reserves its execution identity in
its own transaction and uses that identity as the downstream idempotency key. The downstream
call runs outside PostgreSQL transactions. After the owner confirms it applied the action,
Automation commits the successful execution and its outbox row together.

## Decisions

- Under Decision A, Automation uses generated clients from published contracts for direct action
  commands to Task and Notification. It signs each call for the target service with the
  `automation` actor type and the rule ID. The receiving service owns action authorization and
  its data writes.
- The gateway routes authorized reads. Task supplies current visibility for the public run
  history. Automation has no direct cross-service read path.
