# Pod documentation

Pod is the filesystem-first framework for Norbital tenant workspaces. This directory documents the
framework contracts; template-specific behaviour lives with each template.

Start with the package [README](../README.md). It is the canonical author, operator, and host guide:
workspace layout, generated client, compiler, runtime internals, history, sync, facilities,
`pod.host.ts`, standalone operation, commands, testing, and distribution.

| Deep dive                                 | Covers                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| [Authoring](./AUTHORING.md)               | The mental model: what a workspace declares, what the host supplies, and why.   |
| [Overview](./OVERVIEW.md)                 | A shorter lifecycle and generated-state reference.                              |
| [Core refactor](./CORE_REFACTOR.md)       | What Core must change to run against this Pod. Deferred, not optional.          |
| [Architecture](./ARCHITECTURE.md)         | Runtime invariants, Pod/host boundary, notifications, agents, files, and tests. |
| [Form system](./FORM_SYSTEM.md)           | Schema-derived forms and collection representation overrides.                   |
| [Navigation state](./NAVIGATION_STATE.md) | Application navigation and state conventions.                                   |
| [Sync engine](./SYNC_ENGINE.md)           | Local replica, live query, optimistic mutation, and server transport design.    |
