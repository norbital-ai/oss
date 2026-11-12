# Standard library

`@norbital-ai/std` is the small, dependency-light utility layer shared across Norbital packages.

## Goal

Provide stable, focused primitives for common domain-neutral work without coupling consumers to a larger
framework package.

## Public areas

`billing`, `calendar`, `csv`, `date`, `decimal`, `facts`, `formula`, `hash`, `host-op`, `id`, `json`, `kind`, `label`,
`pricing`, `rows`, `sheet`, `sql`, `vars`, `versioned`, `wire` and `zone` are
public subpaths. There is no package root.

`csv_rows` from `@norbital-ai/std/csv` tokenizes text into raw string cells. Header rules, blank-row policy and value decoding belong to the caller.

`sql` owns identifier (`q`) and standard-conforming string (`literal`) quoting used by native SQL
generators. Query values should remain bound parameters when a database statement supports them.

`id` owns `UUID_PATTERN`, the case-insensitive UUID spelling shared by kinds and native readers.
It accepts every UUID version and the nil identifier; version-specific protocol checks keep their own contract.

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

For JSON text, `parse_json_result` from `@norbital-ai/std/json` returns Effect's typed `Result`: a
`Success` contains `success`, including valid `null`; a `Failure` contains `failure`. The parser
reads the text once. Handle only parse failure here; keep consumer callback
failures with their owning workflow. `parse_json` returns `null` for invalid text. Blank text
is invalid; editors may explicitly treat it as `null`.

`kind` supplies the shared field-kind traits and `input_schema` codec. `wire` supplies `encode_wire`
and `revive_wire`: `$dec` is the only wire tag, while dates and instants are ISO strings. `host-op`
supplies the signed host-operation scheme; `verify_op` returns an Effect with `OpRefused` or the
nonce store's typed failure. These boundary utilities keep their decoding and failure ownership
with the caller.

Decimal arithmetic keeps exact coefficients and scale. Explicit float conversion is
`Decimal.from_number` / `decimal.to_number()`, currency rounding is `round_to`, and zero testing
is `is_zero`. Standard JavaScript serialization hooks retain their native names. Calendar cycle
metadata is decoded strictly using `opens_on`, `second_opens_on` and `every: 'semi_month'`.
Billing catalogue fields use snake_case, including `stripe_price_ids`, `unit_amount_decimal`,
`meter_id`, `tiers_mode`, `up_to`, `trial_days` and `allow_promotion_codes`; amounts and provider
price identities keep their original values.
