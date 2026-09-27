# `@norbital-ai/std`

Value libraries for Bolt workspaces: functions over plain data (RFC §3.7).

See the [standard library overview](./docs/README.md) for the package goal and import guidance.

Import the narrowest public export:

```ts
import { PlainDate } from '@norbital-ai/std/date';
```

Public subpaths are `billing`, `calendar`, `date`, `decimal`, `formula`, `json`, `pdf`, `pricing`, `sheet`,
`versioned` and `zone`. There is no package root.

## Development

```sh
pnpm --filter @norbital-ai/std build
pnpm --filter @norbital-ai/std lint
```
