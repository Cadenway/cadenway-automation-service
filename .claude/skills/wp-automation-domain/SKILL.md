---
name: wp-automation-domain
description: "The data, rules, events and screens waypoint-automation-service owns, taken from the mockup, the integration guide and the repositories document. Load it before naming, modeling or testing anything in this service."
---

# automation-service domain

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
[integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et). When the mockup and this skill disagree, the mockup wins and
this skill is corrected in the same change.
