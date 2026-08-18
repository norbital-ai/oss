# Standard library

`@norbital-ai/std` is the small, dependency-light utility layer shared across Norbital packages.

## Goal

Provide stable, focused primitives for common domain-neutral work without coupling consumers to a larger
framework package.

## Public areas

`async`, `billing`, `cache`, `cel`, `date`, `error`, `finance`, `json`, `reckon`, `result`,
`string`, `text`, `text/dedent`, `tree`, and `truncate` are public subpaths. The package root exposes
only the stable general-purpose subset.

Billing is the shared catalogue and calculation authority for Core seat and usage prices. It is not a
checkout UI, a Stripe integration, or an entitlement engine; those concerns belong to the host app.

## Usage rule

Import the narrowest public subpath, for example:

```ts
import { parseUtcInstant } from '@norbital-ai/std/date';
```

Do not import from `src/` or `build/`. Add a module only when the behaviour is genuinely reusable across
packages and can maintain a compact, framework-independent API.
