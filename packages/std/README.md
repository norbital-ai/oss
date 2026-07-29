# `@norbital-ai/std`

Small shared modules for async operations, billing, caching, CEL, dates, errors, finance, JSON,
schemas, strings, text, trees, and truncation.

See the [standard library overview](./docs/README.md) for the package goal and import guidance.

Import the narrowest public export:

```ts
import { parseUtcInstant } from '@norbital-ai/std/date';
import { typeGuard } from '@norbital-ai/std/schema';
```

Public subpaths are `async`, `billing`, `cache`, `cel`, `date`, `error`, `finance`, `json`, `reckon`,
`result`, `schema`, `string`, `text`, `text/dedent`, `tree`, and `truncate`. The package root
re-exports the stable general-purpose subset.

## Development

```sh
pnpm --filter @norbital-ai/std build
pnpm --filter @norbital-ai/std lint
```
