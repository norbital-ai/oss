# Primitive mapping

How requirement patterns become Bolt primitives. The left column is business language; the middle
is the construction; the right is why. "Default" means the construction that fits most cases and
should be used unless a specific requirement breaks it.

## Data and lifecycles

| Requirement                                                                       | Construction                                                                                 | Notes                                                                                                          |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A record with a lifecycle                                                         | a model with a `state` field (`to` edges, per-state `edit`) and inline exposure              | the state is the only lock and holds on every path; history is always on, nothing to build                     |
| Several genuinely independent lifecycles                                          | separate models when their identity, authority or evidence differs                           | screen sections and value objects do not themselves require another lifecycle                                  |
| A fact that changes over time and must be provable                                | a `period` field + `noOverlap`; successors written by a write callback or automation             | "in force on a date" is a read; precedent: hr-payroll employment terms                                         |
| A structured value that is not a row (bank account, work pattern, regime)         | a custom field (`src/data/custom_field/<name>/`), used as `{ kind: 'custom', of: '<name>' }` | check the built-in kinds first: money, periods, points, files are kinds                                        |
| Values that belong only to one parent (calculation parts, snapshots, preferences) | shaped JSON or a custom datatype inline                                                      | use a child model only when independent row identity, rights, history or relational queries require it         |
| A child that needs independent row semantics while following a parent lock        | a child model with an `owned` relationship                                                   | explicit relation operations through the parent's contract; never delete by omission                           |
| Supported business variation (rates, commissions, extraction schema, catalogues)  | validated runtime configuration records                                                      | source defines the language and evaluator; publish/version or snapshot configuration used by completed records |
| Numbering                                                                         | a `seq` field (`'QT-{yyyy}-{0000}'`, `per` scope)                                            | never reused; never built in the UI                                                                            |
| Totals and counts over children                                                   | `sum` / `count` roll-up fields                                                               | never a stored number a write callback must keep in step                                                       |
| Deletion                                                                          | none by default                                                                              | deletions are grants; prefer terminal states — an approved record should usually end, not vanish               |

## Rules and money

| Requirement                                                                   | Construction                                                                                                                           | Notes                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Money anywhere                                                                | `{ kind: 'money' }` fields and `@norbital-ai/std/decimal`                                                                              | exact end to end; never a float                                                           |
| A document's amounts                                                          | derive amounts once through its write pipeline; use roll-ups for relational lines and a validated parent calculation for inline values | never recompute in the UI; precedent: hr-payroll settlements and trade-operations pricing |
| A figure that must hold up to audit (pay, accrual, contribution, eligibility) | an automation or model write callback over `std/formula` rules and `std/decimal`                                                    | deterministic and replayable; the hr-payroll precedent                                    |
| Derived status (paid, in stock, available)                                    | a roll-up, a computed field, or a query                                                                                                | never store what can be derived                                                           |
| A row invariant                                                               | `check` on the model; a cross-row invariant is a write-callback refusal                                                                | a rule about who may is a grant, not a write callback                                     |

## Work

| Requirement                                            | Construction                                                                           | Notes                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Work on a schedule, after an event, or on a webhook    | `src/automation/+<name>.automation.ts`                                                 | durable; a dropped run reruns from the start; retried on transient failure; owns external business I/O      |
| Judgement inside automated work                        | `ctx.ai.sys_2.infer` with a structured output; `ctx.ai.sys_1.decide` for typed choices | the output shape is the contract with the model                                       |
| Research that must read pages before deciding          | an automation with `ctx.web.read` and the host browser tools its policy grants         | precedent: hr-payroll statutory drift                                                 |
| A computed read, or a write beyond create / update / delete | one read request + a pure `src/lib` helper, or a named `automation(...).run` generator   | reads follow the root's policy; an automation has typed input and output, its start is granted per policy and it yields native `ctx.act` Effects |
| A screen beyond the standard table                     | a page in `src/app/<app>/` with `Table` / `Board` / `Chart` / `Pivot`                  | `$derived` reads; one scroll owner; catalog copy                                      |
| A report of numbers                                    | a root `aggregate` in a read request, or roll-ups                                      | never load wide datasets and regroup in memory                                        |
| A reusable calculation shared by pages and server code | a plain module in `src/lib/`                                                           | with tests alongside                                                                  |

## People

| Requirement                                | Construction                                                                                                                                                                     | Notes                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internal people with different permissions | `src/access_control/policy/+<name>.policy.ts` + source teams under `src/access_control/team/`                                                                                    | team-policy links are source; member affiliation is runtime identity data, with no team/policy editing UI                                                                                                                                                                                |
| A write eligible for approval              | the write grant's `check` returning `ctx.approve(...)`                                                                                                                           | any allow executes; otherwise the first approve commits under an approval request (locked until decided, rolled back on rejection); otherwise the first deny refuses; source team handles route decisions                                                                                 |
| Customers or vendors with accounts         | external members (`audience: 'external'` apps), scoped to their `party`                                                                                                          | invited from a party record                                                                                                                                                                                                                                                              |
| People without accounts (forms)            | a public app (`audience: { public: [...] }`)                                                                                                                                     | create a submission, read published catalogue rows, nothing else                                                                                                                                                                                                                         |
| People without accounts (chat)             | a public envoy (`src/agent/envoy/+<id>.envoy.ts`, `audience: 'public'`) deployed on a conversation connection (`connections: { x: { integration: 'whatsapp', envoy: '<id>' } }`) | unknown senders run under the envoy's policies alone, every operand null except `{ var: 'requestor.instance' }`; field-operations contractors are the private, linked-member variant; the hr-payroll payroll hotline is the private `dm: 'envoy'` variant, scoped per entity by `entity.hotline` |

## The outside world

| Requirement                                            | Construction                                                                                                        | Notes                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Master data owned by another system                    | a model sync's `read` with `$id`, `$version`, cursor and optional `every`/partitions through an integration         | source fields are protected; model update columns hold local annotations without another model                        |
| Local records command another system                   | a model sync's `write` on committed changes, with engine-supplied request idempotency                               | define which system owns each field; preserve local business lifecycle and reconcile source evidence through its sync read |
| A provider writing into the workspace                  | an automation `webhook` trigger with `verify` (bearer, HMAC, Svix, Stripe, Slack, Meta)                             | unsigned deliveries are refused                                                                                            |
| The workspace writing to a provider                    | a `+workspace.ts` connection + `ctx.request` in an automation, or a model sync's `write`                            | stable request identity (a rerun asks again); verify retry behaviour rather than assuming exactly-once delivery        |
| A browser SDK or client library (maps, CAD, documents) | a normal page dependency                                                                                            | a dependency, not an integration                                                                                           |
| Remote tools for the agent                             | `src/agent/mcp/+<name>.mcp.ts`                                                                                      | granted by policy                                                                                                          |
| Secrets                                                | an integration's `credential`, sealed per instance at pairing; OAuth clients, MCP settings: `src/+secrets.ts` names | values set per tenant; never in source or seeds                                                                            |

## Anti-patterns

Refuse these while mapping; each is a specific past failure:

- **Storing a derived number** (paid status, stock position, remaining quantity, remaining to
  receive). Make it a roll-up, a computed field or a query.
- **Money computed in more than one place.** One write callback computes a line; everything else sums.
- **System UUIDs or `*_id` keys in any UI.** Representations are human-readable by rule.
- **Raw text in Svelte markup** — every user-facing string comes from the message catalogs
  (base locale + Chinese, same keys).
- **`refetch`/`invalidate` thinking** — reads are live and reactive; there is no refetch to call.
- **Wide datasets loaded to be regrouped in memory** — `aggregate` and roll-ups exist for
  reporting.
- **One model, two lifecycles** (a document that is also an approval, a product that is
  also an order).
- **Editing committed history** — document lines and status transitions are events; corrections
  are new records or transitions with reasons, not edits.
