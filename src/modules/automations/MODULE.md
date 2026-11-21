# Automations

## Purpose

Owns organization-scoped rules and the history of their applied actions. Task owns task state and
task visibility. Notification owns notification delivery.

The current milestone registers the module and adds the rule domain. The API, event handlers,
execution storage and action clients below describe the P6 runtime that follows contract publication.

## Public entry points

None.

## Owned tables

None in this milestone. P6 persistence will store rules, execution identities and applied actions
in this service's database with row-level security forced by organization.

## API

The draft internal OpenAPI contract defines these operations:

| Method and path                            | Operation ID                          |
| ------------------------------------------ | ------------------------------------- |
| `GET /internal/v1/automations`             | `listAutomationRulesInternal`         |
| `POST /internal/v1/automations`            | `createAutomationRuleInternal`        |
| `PATCH /internal/v1/automations/{ruleId}`  | `updateAutomationRuleInternal`        |
| `DELETE /internal/v1/automations/{ruleId}` | `deleteAutomationRuleInternal`        |
| `GET /internal/v1/automation-runs`         | `listAutomationRunCandidatesInternal` |

The gateway checks current owner or administrator membership with Organization before calling
these operations. Automation checks the signed gateway issuer, service audience, user actor and
organization, then scopes every lookup and write to that tenant. Creating an assignment or
notification rule requires an active recipient in that organization.

The internal history pages through a window of at most 100 recent applied actions. Its cursor
binds the actor, organization, operation and window. For the public history, the gateway checks
each task's current visibility with Task as the requesting user and returns up to eight visible
executions from that window.

## Events emitted

The draft AsyncAPI contract defines `evt.automation.executed.v1` for a successfully applied action.
Its actor has type `automation` and its ID is the rule ID. The outbox relay delivers the fact at
least once. The planned Billing consumer can deduplicate it by event ID.

## Events consumed

The P6 runtime will consume `evt.task.created.v1` and `evt.task.status-changed.v1` from Task.
The installed contracts and registered handlers will determine the exact message validation and
durable consumer bindings.

## Invariants

- A rule matches creation or a transition to its configured status. Its single action assigns a
  user, changes priority, sends a notification or adds a comment.
- Events from an `automation` actor are ignored to prevent action-triggered loops. Disabled or
  deleted rules are ineligible for new trigger decisions. An unchanged enablement keeps the
  current rule version.
- The tenant, rule and triggering event identify one execution across retries. Only applied
  actions enter history and emit an execution fact. A no-op, skipped or failed action does not.

## Transactions

The planned write use cases own the tenant transaction. Creating a rule uses the kit's
actor-and-tenant-scoped idempotency when the caller supplies a key. Enablement and deletion check
`If-Match`, when present, within the write transaction.

The event handler durably records the trigger receipt and execution identity before handing the
action off. The application calls the downstream owner outside its database transaction and
reuses the execution identity as the retry key. After the downstream owner confirms the action
was applied, Automation commits the successful execution and its outbox row together.

## Decisions

- Under Decision A, Automation uses generated clients from published contracts for direct action
  commands to Task and Notification. It signs each call for the target service with the
  `automation` actor type and the rule ID. The receiving service owns action authorization and
  its data writes.
- The gateway routes authorized reads. Task supplies current visibility for the public run
  history. Automation has no direct cross-service read path.
