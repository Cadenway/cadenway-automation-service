# Domain and integration

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

**Status:** This page records the target design from repository instructions and skills. Its behavior has not been verified as implemented in this snapshot.

The tables and rules on this page are **target domain behavior**, not proof of a running service or an approved API. Source: `wp-automation-domain` ([Claude](../.claude/skills/wp-automation-domain/SKILL.md), [Codex](../.codex/skills/wp-automation-domain/SKILL.md)). The linked mockup and guides remain the source for product details; confirm ambiguous values before implementation.

## What this service owns

"When… then…" rules.

**Data**: Rules and their execution log.

**API**: Rules (list, create, enable, delete), latest runs.

**Events emitted**: `automation.executed`.

**Events consumed**: `task.created`, `task.status-changed`.

**External systems**: None.

**Mockup screens**: The Automations dialog (general rules).

## Rules this service guards

- Triggers: task created, or status becomes X. Actions: assign, change priority, notify someone, add a comment.
- Actions go through task-service and notification-service APIs with the source `automation`; this service never writes their data.
- The dialog shows the 8 latest runs.

## Notes

Starts as a module of waypoint-task-service.

Everything above comes from the [repositories document](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N) and the
[integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et). If the mockup disagrees with this guide, update the guide and its source skill for both assistants.

## Contract and delivery sequence

The `waypoint-api-contracts` repository owns HTTP and event specifications. Consumers use published `@waypoint/contracts` packages and `@waypoint/nest-messaging`; do not redefine payloads or connect to another service's database. Change contracts first, then the producing service, followed by gateways and listeners, and finally the webapp. Planned event names on this page must be checked against the actual published specification before use.

## References

[Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et), and [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N). Use [AGENTS.md](../AGENTS.md) as the local source for ownership and hard limits.
