# Pod documentation

Pod is the filesystem-first framework for Norbital tenant workspaces. This directory documents the
framework contracts; template-specific behaviour lives with each template.

| Guide                                     | Covers                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| [Pod specification](./POD_SPEC.md)        | Normative workspace, compiler, runtime, client, startup, and acceptance contract.     |
| [Overview](./OVERVIEW.md)                 | Authoring roles, commands, generated state, runtime boundary, and template lifecycle. |
| [Architecture](./ARCHITECTURE.md)         | Implemented Pod/host, build, data, sync, and verification boundaries.                 |
| [Form system](./FORM_SYSTEM.md)           | Schema-derived forms and collection representation overrides.                         |
| [Navigation state](./NAVIGATION_STATE.md) | Application navigation and state conventions.                                         |
| [Sync engine](./SYNC_ENGINE.md)           | Local replica, live query, optimistic mutation, and server transport design.          |

Start with the Pod specification. The sync-engine specification is normative for data behavior;
architecture and overview documents explain the implemented structure behind those contracts.
