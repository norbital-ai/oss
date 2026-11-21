# Entity boundaries and runtime configuration

Read before adding a model, splitting a catalogue or designing configurable behaviour.

## Design order

1. Learn the domain: its jobs, actors, inputs and the variations its users need. Do not map every prompt noun to a model.
2. Merge same-stream variants sharing parent, timeline/feed and actor into one polymorphic model (`kind` + discriminated-union custom datatype or shaped `json`). Split only when lifecycles, permissions or foreign-key targets diverge.
3. Co-locate compound values into one typed attribute: prefer built-in kinds (`period`, `money`, `state`, `count`, `file`) first, then a reusable custom datatype. Never scatter one concept across loose scalar pairs or duplicate its sub-fields beside it. Drop speculative fields with no active consumer.
4. Represent supported variation as validated runtime configuration. Source defines its types, operations and invariants; extend source when the requested behavior exceeds that language. Do not build a universal interpreter to avoid an ordinary source change.
5. Use the fewest models that hold the data. Prefer, in order: a built-in kind; a custom datatype (including tagged unions) or shaped `json` on the owner; an owned child model; a separate model.
6. Take a model over a custom datatype only when the data needs a foreign-key constraint, its own view, its own lifecycle, permissions or approval, history, or relational queries.
7. Nest each model's folder under the model that owns it: `data/model/<root>/<child>/+model.ts`. Group catalogues and settings under one settings root. The tree reads as the domain.

## Choose storage

Name the records people find, the actions they take and the changes to prove. A screen, tab, schema property or noun does not justify a model.

| Need                                                                        | Use                                                                                                 |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A scalar or pair with a built-in meaning (range, money, state, count, file) | its built-in field kind                                                                             |
| A structured or polymorphic value meaningful within one parent              | shaped `json` or a custom datatype (including tagged unions) on the parent                          |
| A reusable compound value with its own validation or editor                 | a custom field and companion renderer                                                               |
| Child rows needing FKs, row queries or independent edits under a parent     | an owned child model (`inverse`); commit initial children atomically with parent via layers/`act`   |
| Authoritative accounting, balance, inventory or entitlement facts           | an append-only transactional ledger model (`locked` once posted, offsetting entries, derived total) |
| Independent identity, lifecycle, permissions, history or relational queries | a model                                                                                             |
| Reused, effective-dated configuration other records reference               | a runtime catalogue model                                                                           |
| A result derivable from existing facts                                      | a computed field, roll-up, or a read plus a pure helper                                             |

- Inline a value when its entries are born, edited, sealed and discarded with the parent.
- Keep stable item keys when operations or references need them; an array position is not identity.
- Keep a model when rows are referenced independently, reused across parents, approved separately, queried through relationships, retained as evidence, or edited by a different authority.
- Use an owned relationship when a child needs row semantics but follows its parent's lifecycle.
- A link model needs a reason beyond rendering two IDs.

## Before inlining a child model

Inspect its readers, writers, policies, automations, seeds and syncs. Preserve:

- Foreign-key existence, visibility, delete restrictions and inverse queries.
- Stable IDs referenced by ledgers, documents or later actions.
- Revision conflicts, approval workflows and history.
- Required fields, ordering, duplicate prevention and parent-state restrictions.
- Filters, aggregates, full reads and configured UI operations.

- A nested `id` is not a foreign key. A custom datatype's `validate` is pure and cannot check another model: use a batched write callback.
- Never exchange an enforced relationship for an unvalidated string.
- A parent owning a value list means its revision and history cover the whole value.
- Use the shared structured-value or matrix renderer. Never invent an entity to get a table editor. A custom editor must expose every supported setting.

## Configure variation at runtime

- Source defines shape, operations, evaluator and invariants. Authorized records hold rates, thresholds, formulas, schemas, instructions, templates and effective dates.
- A supported business variant is a configuration edit, not a branch keyed to a customer or template.
- Use the model write engine: policies grant editing, state locks enforce publishing, a grant's `check` routes approval.
- Declare a publishing lifecycle with a native `state` field, not an enum plus a hand-written lock.
- A worker that publishes at once creates the draft, then takes the same validated transition.
- Validate configuration before publishing or using it. Version or snapshot it when an old result must stay reproducible.
- Keep execution code generic over the configuration language; add source capability only when the language cannot express the need.
- Never add an unrestricted code field or an untyped configuration blob.
- Teams, policy links and approval routes are source, never runtime catalogue values.

## Runtime schemas and formulas

- `ctx.ai.sys_2.infer` accepts `output: { json_schema, rules? }`; rules are CEL `{ expression, message }` checks. Validate with the same selected version when correcting stored results.
- `StructuredData` renders schema-driven values, edits, schema documents and inline diffs. Rendering is not validation: keep server schema and rule checks authoritative. Remote references are not fetched.
- A schema property picks a Bolt datatype explicitly with `format: '<datatype>'` (a custom datatype: `"x-norbital": { "datatype": "<name>" }`), or implicitly when an object's shape is exactly a period or point, all keys required. Explicit wins. JSON Schema's own string formats keep their meaning.
- `bolt check` and `bolt build` hold every seed value declaring `$schema` to this: a `format` naming no datatype, or the wrong shape, fails with its path.
- A `text` field with `format: 'cel'` supplies the formula editor only. Source compiles and evaluates the scope with the Bolt formula exports, including result type and failure handling.

## Review

- For each proposed model, state its archetype (entity, owned child, or transactional ledger) and the identity or behaviour preventing consolidation into a polymorphic model or custom datatype.
- Confirm every compound value lives in one built-in datatype or reusable custom datatype—no loose scalar pairs, scattered parallel columns, duplicated sub-fields, or unused speculative fields.
- For each removed model, state where its validation, authority, history and references now live.
- Verify a normal change, an invalid configuration and a locked or unauthorized change through the real write path.
