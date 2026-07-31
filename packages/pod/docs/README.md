# Pod documentation

Pod is the filesystem-first framework for Norbital tenant workspaces. This directory documents the
framework contracts; template-specific behaviour lives with each template.

Start with the package [README](../README.md). It is the canonical author, operator, and host guide:
workspace layout, generated client, compiler, runtime internals, history, sync, facilities,
`pod.host.ts`, standalone operation, commands, testing, and distribution.

| Deep dive                                     | Covers                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| [Authoring](./AUTHORING.md)                   | What a workspace declares, what the host supplies, and the authoring principles. |
| [Overview](./OVERVIEW.md)                     | Short lifecycle, generated-state, runtime and trust-boundary reference.          |
| [Architecture](./ARCHITECTURE.md)             | Runtime invariants, deployment targets, facilities, notifications and files.     |
| [Agent architecture](./AGENT_ARCHITECTURE.md) | Loop, tools, transcripts, channels, UI and the host boundary.                    |
| [Sync engine](./SYNC_ENGINE.md)               | Local replica, live query, optimistic mutation and server transport design.      |
| [Form system](./FORM_SYSTEM.md)               | Schema-derived forms and collection representation overrides.                    |
| [Navigation state](./NAVIGATION_STATE.md)     | Application navigation and state conventions.                                    |

Migration diaries, takeover notes and cross-repository refactor checklists are intentionally not
part of this documentation set. Current contracts belong in the architecture guides; work tracking
belongs in issues and pull requests.
