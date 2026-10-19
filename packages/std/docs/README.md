# Standard library

`@norbital-ai/std` is the small, dependency-light utility layer shared across Norbital packages.

## Goal

Provide stable, focused primitives for common domain-neutral work without coupling consumers to a larger
framework package.

## Public areas

`billing`, `calendar`, `csv`, `date`, `decimal`, `facts`, `formula`, `host-op`, `json`, `kind`, `label`,
`pricing`, `sheet`, `versioned`, `wire` and `zone` are
public subpaths. There is no package root.

`csvRows` from `@norbital-ai/std/csv` tokenizes text into raw string cells. Header rules, blank-row policy and value decoding belong to the caller.

Billing is the shared catalogue and calculation authority for Norbital base (per-workspace) and usage
prices — the website's pricing page reads it directly, and a host reads it to price a plan. It is not a checkout
UI, a Stripe integration, or an entitlement engine; those concerns belong to the host app.

## Usage rule

Import the narrowest public subpath, for example:

```ts
import { PlainDate } from '@norbital-ai/std/date';
```

Do not import from `src/` or `build/`. Add a module only when the behaviour is genuinely reusable across
packages and can maintain a compact, framework-independent API.

For JSON text, `parseJsonResult` from `@norbital-ai/std/json` returns Effect's typed `Result`: a
`Success` contains `success`, including valid `null`; a `Failure` contains `failure`. The parser
reads the text once. Handle only parse failure here; keep consumer callback
failures with their owning workflow. `parseJson` returns `null` for invalid text. Blank text
is invalid; editors may explicitly treat it as `null`.

`kind` supplies the shared field-kind traits and `inputSchema` codec. `wire` supplies `encodeWire`
and `reviveWire`: `$dec` is the only wire tag, while dates and instants are ISO strings. `host-op`
supplies the signed host-operation scheme; `verifyOp` returns an Effect with `OpRefused` or the
nonce store's typed failure. These boundary utilities keep their decoding and failure ownership
with the caller.
