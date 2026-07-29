# Configuration package

`@norbital-ai/config` is the tiny shared configuration package for the Norbital workspace.

## Goal

Keep common compile-time settings consistent without adding a runtime dependency or a hidden build layer.

## What it provides

| Export                            | Use                                                                   |
| --------------------------------- | --------------------------------------------------------------------- |
| `@norbital-ai/config/svelte.json` | Shared TypeScript configuration for Svelte packages and applications. |

Packages and apps extend this configuration from their own `tsconfig.json`. Project-specific compiler
aliases, generated paths, and application settings remain local to the consuming project.

## Boundaries

- It contains configuration only—no runtime code, UI, framework behaviour, or package exports beyond
  shared config files.
- Do not add an application-specific setting here merely to avoid local configuration.
- Version it with the public platform release whenever a consumer-visible configuration change is made.
