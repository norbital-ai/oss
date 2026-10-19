# `@norbital-ai/std`

Value libraries and shared boundary codecs for Bolt workspaces (RFC §3.7).

See the [standard library overview](./docs/README.md) for the package goal and import guidance.

Import the narrowest public export:

```ts
import { PlainDate } from '@norbital-ai/std/date';
```

Public subpaths are `billing`, `calendar`, `csv`, `date`, `decimal`, `facts`, `formula`, `host-op`,
`json`, `kind`, `label`, `pricing`, `sheet`, `versioned`, `wire` and `zone`. There is no package root.

`csvRows` from `@norbital-ai/std/csv` returns raw string cells; callers own headers, blank-row handling and value decoding.

## Development

```sh
pnpm --filter @norbital-ai/std build
pnpm --filter @norbital-ai/std lint
```
