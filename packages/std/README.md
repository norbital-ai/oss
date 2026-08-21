# `@norbital-ai/std`

Small shared modules for billing, collections, dates, errors, finance, internationalization, JSON,
rate limits, deterministic computation, secrets, strings, and trees.

See the [standard library overview](./docs/README.md) for the package goal and import guidance.

Import the narrowest public export:

```ts
import { parseUtcInstant } from '@norbital-ai/std/date';
```

Public subpaths are `billing`, `collection`, `date`, `error`, `finance`, `i18n`, `json`, `rate-limit`,
`reckon`, `secret`, `string`, and `tree`. The package root re-exports the stable general-purpose
subset.

## Development

```sh
pnpm --filter @norbital-ai/std build
pnpm --filter @norbital-ai/std lint
```
