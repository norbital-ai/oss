# Primitive mapping

How requirement patterns become Bolt primitives. The left column is business language; the middle
is the construction; the right is why. "Default" means the construction that fits most cases and
should be used unless a specific requirement breaks it.

## Data and lifecycles

| Requirement                                                                  | Construction                                              | Notes                                                                                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A record with a lifecycle                                                    | collection + `status` enum + a `+hooks.ts` transition map | the hook refuses every transition not in the map; history and audit are system columns, nothing to build   |
| One entity, several independent lifecycles                                   | separate collections                                      | a collection trying to be two lifecycles is a modelling error; split it                                    |
| A fact that changes over time and must be provable                           | effective-dated facts                                     | precedent: hr-payroll employee facts                                                                       |
| A structured value that is not a row (money, address, bank account, pattern) | a `datatypes/<name>` definition + renderer                | JSONB storage; the definition is the only schema                                                           |
| Two things that belong to each other (document lines, shipment items)        | a child collection with a relationship                    | children snapshot their parent's context (price, code, name) at creation; precedent: crm quote_lines       |
| Numbering, uniqueness, versions                                              | a hook (before create) + text columns                     | numbering rules are business logic; put them in the hook, not in the UI                                    |
| Deletion                                                                     | none by default                                           | deletions are policy; prefer lifecycle terminal states — an approved record should usually end, not vanish |

## Rules and money

| Requirement                                                                   | Construction                                                                                  | Notes                                                                                   |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Money anywhere                                                                | `money` datatype per workspace                                                                | currency, rounding, tax modes from `@norbital-ai/std` finance                           |
| A document's amounts                                                          | compute each line's net/tax/total once, in the hook; totals are sums of already-rounded lines | never recompute in the UI; precedent: crm                                               |
| A figure that must hold up to audit (pay, accrual, contribution, eligibility) | a reckon computation graph                                                                    | deterministic, replayable, hashable — the hr-payroll precedent                          |
| Derived status (paid, in stock, available)                                    | derive at render from events                                                                  | never store what can be derived; precedent: crm settlement and goods-receipt derivation |
| Business rules with conditions                                                | hooks + CEL where a rule is a small expression                                                | a rule that is policy (who may) belongs in a policy, not a hook                         |

## Work

| Requirement                                    | Construction                                                      | Notes                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Work on a schedule or after an event           | `src/automations/+<name>.ts`                                      | durable and idempotent by contract; the automation is re-run, not re-implemented, on failure |
| Judgement inside automated work                | `api.infer` with a structured output schema                       | the schema is the contract with the model; never free-form text as the output                |
| A custom endpoint or dashboard                 | `src/functions/+<name>.ts` (query/command)                        | schemas are Effect `Schema`; the payload is validated at dispatch                            |
| A screen beyond the standard table             | an app (`src/apps/+<name>.svelte`) + CollectionTable/kanban/chart | `$derived` queries; one scroll owner; bilingual copy                                         |
| A report of numbers                            | `findGrouped` / `aggregate` in an app or function                 | never load wide datasets and regroup in memory                                               |
| A reusable calculation shared by UI and server | a plain module in `src/lib/` imported by both                     | with tests alongside                                                                         |

## People

| Requirement                               | Construction                                              | Notes                                                                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internal roles with different permissions | `src/access/policies/+<name>.ts` + `src/access/+teams.ts` | policy is source: who may read what, what needs approval. A person is on exactly one team, so a combination of authority is its own named team; there are no roles. Precedent: field-operations |
| A decision that needs a second person     | an approval flow on the policy                            | write-then-lock: the write lands pending, approval moves it; the `norbital-platform` skill has the behaviour                                                                                    |
| External people with accounts             | policies + teams, same as internal                        | nothing special about external users except which team they are put on                                                                                                                          |
| External people without accounts          | an envoy agent surface                                    | scoped by policy to their own records; precedent: field-operations contractors on WhatsApp                                                                                                      |

## The outside world

| Requirement                                                     | Construction                                                                                     | Notes                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Master data owned by another system                             | a mirrored collection with `external_code`, kept in step by a scheduled pull (cursor + identity) | mirrors are edited in place; documents go back out; precedent: crm           |
| A provider writing into the workspace                           | a signed inbound webhook binding                                                                 | unsigned deliveries are refused; the signature header is mandatory           |
| The workspace writing to a provider                             | an outbound send with a vault credential                                                         | outbox semantics: the send is retried, never duplicated                      |
| A browser SDK or client library (maps, CAD, physics, documents) | a normal dependency in the workspace package                                                     | precedent: `pdq-wasm`, `exceljs`, `exifr` — a dependency, not an integration |
| Remote tools for the agent                                      | an MCP server declaration in `src/capabilities/mcp/`                                             | servers are granted by policy                                                |
| Secrets                                                         | `+env.ts` declarations; values entered in the vault                                              | server-only by construction                                                  |

## Anti-patterns

Refuse these while mapping; each is a specific past failure:

- **Storing a derived number** (paid status, stock position, remaining quantity, remaining to
  receive). Derive it at render from the events that decide it.
- **Money computed in more than one place.** One hook computes a line; everything else sums.
- **System UUIDs or `*_id` keys in any UI.** Representations are human-readable by rule.
- **Raw text in Svelte markup** — the compiler rejects it; every user-facing string comes from
  the catalogs (English + Chinese, same keys).
- **`refetch`/`invalidate` thinking** — reads are live and reactive; there is no refetch to call.
- **Wide datasets loaded to be regrouped in memory** — `findGrouped`/`aggregate` exist for
  reporting.
- **One collection, two lifecycles** (a document that is also an approval, a product that is
  also an order).
- **Editing committed history** — document lines and status transitions are events; corrections
  are new records or transitions with reasons, not edits.
