# Platform utilities

`@norbital-ai/platform-utils` holds the portable contracts shared by Pod, tenant workspaces, and hosts.

## Goal

Define stable interfaces at platform boundaries so a workspace can be authored, built, and run without
depending on a particular host implementation.

## Pillars

| Area                 | Responsibility                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Collections          | Query, mutation, client, schema, and system-collection contracts.                               |
| Manifest and runtime | Workspace manifest parsing, runtime bindings, wire contracts, and policy scope types.           |
| Tenant lifecycle     | Source, build-output, migration, database bootstrap, and provider contracts.                    |
| Seed lifecycle       | Authoring, planning, manifest, and execution contracts.                                         |
| Host adapters        | Optional adapters such as MinIO parsing, the SvelteKit guard, and Neon tenant-database support. |

## Boundaries

Pod owns framework authoring, compilation, and runtime behaviour. A host owns infrastructure,
credentials, tenant provisioning, and platform policy. This package carries the contracts between them;
it does not choose a host, deliver a template, or implement tenant business logic.

Import the narrowest public subpath documented in the package README. Do not import source or build paths
directly.
