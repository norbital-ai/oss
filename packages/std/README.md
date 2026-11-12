# `@norbital-ai/std`

Value libraries and shared boundary codecs for Bolt workspaces (RFC §3.7).

See the [standard library overview](./docs/README.md) for the package goal and import guidance.

Import the narrowest public export:

```ts
import { PlainDate } from '@norbital-ai/std/date';
```

Public subpaths are `billing`, `csv`, `date`, `decimal`, `formula`, `host-op`,
`hash`, `id`, `json`, `kind`, `label`, `sheet`, `sql`, `vars`, `versioned`, `wire` and `zone`. There is no package root.

`csv_rows` from `@norbital-ai/std/csv` returns raw string cells; callers own headers, blank-row handling and value decoding.

Decimal methods use `from_number`, `round_to`, `is_zero` and `to_number`. Standard JavaScript
hooks `toString`, `toJSON` and `valueOf` retain their required names; `$dec` remains the wire tag.

## Development

```sh
pnpm --filter @norbital-ai/std build
pnpm --filter @norbital-ai/std lint
```
