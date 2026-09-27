# UI package

`@norbital-ai/ui` is the shared visual system for Norbital interfaces and Bolt tenant apps.

## Goal

Give applications accessible, consistent Svelte components and layout primitives while keeping domain
logic and tenant presentation decisions in the workspace that uses them.

## What belongs here

| Layer               | Responsibility                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Design foundation   | Tokens, base styles, typography, colour, editor themes, logos, and favicons.             |
| Portable primitives | Buttons, cards, dialogs, inputs, layout primitives, navigation, and feedback components. |
| Views               | Table, Board, Form, RecordShell and the other collection views of RFC §3.6.              |

## Boundaries

- Import from `.`, `./layout` or `./capture`, never `src/` or `build/`.
- Import `@norbital-ai/ui/base.css` once at an application root. Bolt does this for generated tenant
  clients, so a tenant must not add a second base stylesheet or Tailwind integration.
- Keep tenant-specific workflows, data fetching, collection hooks, and one-off visual treatment out of
  this package.
