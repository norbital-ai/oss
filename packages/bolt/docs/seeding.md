# Seeding

A template's rows come from three sources. Each has one place, one reader and one destination.

| Source  | Lives in                              | Committed           | In the release       | Reaches                                      |
| ------- | ------------------------------------- | ------------------- | -------------------- | -------------------------------------------- |
| public  | the template's `seed/public/**`       | the template        | yes, the `base` pack | every environment's provision and reset      |
| test    | the template's `seed/test/**`         | the template        | never                | the template's own `bolt test`               |
| private | a bank tree (`<bank>/<tree>/rows/**`) | the bank repository | never                | `bolt seed`, in memory, into one environment |

Public rows are data anyone may read (HR's jurisdiction settings are the one public seed today). Test rows are the
synthetic fixtures a template's tests need. Private rows are a client's migration or a demo's people and records: they
exist in the bank repository (or another external store) and in the memory of one `bolt seed` run, never in a
release, a host's disk or a template checkout.

## Layout

`seed/` is reserved. Everything in it is one of:

```
seed/
  +seeder.ts                  optional: names the bank tree (below)
  public/**/<model>.json[.gz] public rows; a directory groups files, the file name is the model
  public/assets.json          public assets: [{ path, sha256, bytes, contentType }]
  public/assets/**            their bytes
  test/**/<model>.json[.gz]   test rows (a directory may name a scenario)
  test/assets.json, test/assets/**
```

Any other file under `seed/` is a `seed-layout` diagnostic. A bank tree holds its rows as
`<bank>/<tree>/rows/**/<model>.json[.gz]`; a `file` value names a path relative to `<bank>/<tree>/` unless
`seed/public/assets.json` carries it.

Each row carries its `id` and stored fields in their wire form (decimals as numbers, numeric text or `{ "$dec" }`;
dates, instants and ids as text). Identity rows are `sys_user` (`team` names a source team handle) and unnamed
`sys_integration` instances. Rows load as stored: nothing transforms them.

## `+seeder.ts`

Without a seeder a template has only its public and test rows. A seeder names the bank tree its private rows live in:

```ts
import { seeder } from '@norbital-ai/bolt';

export default seeder({
	bank: {
		/** The bank tree `bolt seed` reads: `<bank>/norbital_hr/rows/**`. */
		tree: 'norbital_hr',
		/** Automations queued once with the rows when they load. */
		start: ['recompute_balances']
	}
});
```

`bolt check` loads the seeder (a seeder that cannot load is a `seed/seeder` error) and decodes every public and test
row against the manifest (`seed/decode`); `bolt seed` decodes the public rows joined with the private rows the same
way, checks `start` names automations (`seed/start`) and that every named asset exists, before anything is sent.

## Commands

- `bolt build` writes the `base` pack (the public rows) and the `test` pack. A release carries `base` only.
- `bolt test` seeds each test from the `test` pack unless the test passes its own rows.
- `bolt seed --bank=<checkout> --target=<colony url> --tenant=<handle>` reads the bank tree, runs the seeder in
  memory, decodes the rows, and asks the target to reset the environment to public ∪ private rows. Assets go to the
  host's object store, rows in the request; the host restores them into the tenant database and keeps neither. The
  call is a signed host operation (`NORBITAL_OPS_SECRET` for `NORBITAL_OPS_SCOPE`, default `local`).

`bun run env -- reset` and `env deploy reset` call `bolt seed` for each template whose seeder names a bank tree, so a
demo environment gets its private rows after every reset. A template without one stays at its public rows.
