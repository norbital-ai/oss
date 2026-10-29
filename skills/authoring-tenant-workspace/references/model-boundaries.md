# Entity boundaries and runtime configuration

Use this reference before adding models, splitting a catalogue or designing configurable business
behaviour. Field syntax and write contracts live in [models-and-modeling.md](models-and-modeling.md).

## Start with the model and the task

Name the records people find in a table, the actions they take and the changes that must be proved.
Then choose storage. A screen, tab, schema property or noun does not by itself justify a model.
Keep the smallest set of entities that preserves the required behaviour.

| Need                                                                           | Prefer                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| A scalar with a built-in meaning                                               | its built-in field kind                                      |
| A structured value meaningful only within one parent                           | shaped `json` or a custom datatype on that parent            |
| A reusable value shape with validation or editing beyond the built-in renderer | `customField` plus its companion renderer                    |
| Independent identity, lifecycle, permissions, history or relational queries    | a model                                                      |
| Reused, effective-dated configuration that other records reference             | a runtime catalogue model                                    |
| A result derivable from existing facts                                         | a computed field, roll-up, or a read plus a `src/lib` helper |

Prefer inline values when their entries are born, edited, sealed and discarded with the parent.
Arrays of document snapshots, calculation breakdowns, ranked preferences and extraction results
often fit. Keep stable item keys when operations or downstream references need them; do not use
an array position as identity.

Keep a model when its rows are referenced independently, reused across parents, approved
separately, queried through relationships, retained as their own evidence or edited by a different
authority. An owned relationship is appropriate when a child needs those row semantics while
following its parent's lifecycle. A link model needs a reason beyond rendering two IDs.

## Check what inlining would remove

Before replacing a child model, inspect its readers, writers, policies, automations, seeds
and model syncs. Preserve the behaviour rather than only copying its columns into JSON:

- Foreign-key existence, visibility, deletion restrictions and inverse relationship queries.
- Stable IDs referenced by ledger entries, documents, source records or later actions.
- Independent revision conflicts, approval workflows and history.
- Required fields, ordering, duplicate prevention and parent-state restrictions.
- Filters, aggregates, full reads and configured UI operations.

A nested `id` value is not a database foreign key. A custom datatype's `validate` callback is pure;
it can validate shape, ranges and duplicates, but cannot check another model. Use a batched
model write callback for checks that read records. Do not silently exchange enforced
relationships for unvalidated strings. If the parent now owns a value list, its revision and
history must cover changes to that whole value.

Use the shared structured-value or matrix renderer to inspect and manage related information
where it is meaningful in context. An inline value does not need a second record representation.
A real child record should still open its complete representation when a person needs its full
task. Do not invent another entity solely to get a table editor.
Prefer the declared structured-field editor for configuration. A custom editor must preserve and
expose the supported settings rather than reduce the object to a few hand-picked fields.

## Configure business variation in runtime

Source defines the shape, allowed operations, evaluator and invariant checks. Authorized runtime
records hold the choices: rates, thresholds, formulas, extraction schema, instructions, templates,
catalogue entries and effective dates. Adding a supported business variant should usually mean
editing configuration, not adding a branch keyed to a customer or a template name.

Use the existing model write engine for those changes. Policies grant who may edit configuration;
state locks enforce publishing invariants. For approval-only changes the grant's `check` returns
`ctx.approve(...)`; another held policy's `ctx.allow()` executes directly. A routed edit is written at once and locked by its request until it
is approved, or rolled back on rejection; reuse native review and record controls. Test direct
edits, routed edits, unmatched denial, rejection rollback and the lock.
Declare a publishing lifecycle with a native `state` field and its transition/edit rules, rather
than an enum plus a hand-written lock. New records start in the declared initial state; a worker
that publishes immediately creates the draft, then takes the same validated transition. Serial
PCN's category structures and System Technic's job variants use this pattern, so native record
controls also see the closed state.
Validate the configuration before publishing
or using it. Version or snapshot configuration when an old result must remain reproducible; a
runtime edit must not rewrite what a completed document meant. The execution code stays generic
over the declared configuration language. Add a source capability only when the language cannot
express the requirement.

Avoid an unrestricted code field or a generic configuration blob that bypasses types and guards.
Use typed fields, shaped data, or the supported formula/schema language. Teams, policy links and
approval routes are source configuration, not business catalogue values editable at runtime. Runtime configurability
does not remove the need for validation, authorization, deterministic calculations or evidence.

### Runtime schemas and formulas

For runtime extraction schemas, `ctx.ai.sys_2.infer` accepts `output: { jsonSchema, rules? }`;
the optional rules are `{ expression, message }` CEL checks. This keeps structure and cross-field
checks in the selected configuration. Validate the configuration before publishing and use the
same selected version when validating or correcting stored results.

`StructuredData` from `@norbital-ai/ui` renders schema-driven values, edits, schema documents,
and inline diffs. Pass `schema`, `value`, the change callback and validation errors through the
owning form/controller; pass a declared `kind` when native datatypes or hidden fields are known.
Decode a stored schema once with `isJsonSchema`. Layout is automatic and compact: label/value
rows, nested disclosures, and repeated values in the same `Table` used for models. Schema
mode shows primitive types; schema mode with `onChange` authors property rows while preserving
other schema keywords. Diff mode keeps that form/table layout, with red struck-through previous
values and green current values; explicit `arrayKeys` map JSON Pointers to stable row identities.
Without a schema, inference describes observed values without inventing formats or requirements.
Remote references are not fetched. Rendering is not validation: keep server JSON Schema/rule
checks authoritative. Use the shared native datatype registry rather than template-specific
property renderers.

A `text` field with `format: 'cel'` supplies the shared formula editor; it does not evaluate the
expression. Source must explicitly compile and evaluate the supported formula scope with
`@norbital-ai/std/formula`, including result type and failure handling. The runtime configuration
chooses the expression and parameters, not arbitrary JavaScript.

## Existing examples and their boundaries

- **HR Payroll:** payslips keep `base`, `proration`, `statutory` and `adjustments` within the
  settlement record. These describe one calculation and do not each need a model. The
  `statutory_contribution_catalog` stores an executable configuration with CEL expressions and
  ordered rules; allowance catalogues store eligibility and amount expressions. Catalogue
  versions and employee settlements have different reuse and evidence needs, so their row
  boundary still matters.
- **System Technic:** `job_types` keeps the extraction `definition` and report `template` together
  as one versioned variant. Publishing validates both and locks the version. New capture schemas
  and instructions are runtime data consumed by the generic extraction path; there is no model
  for every extracted schema property.
- **Trading Operations:** `commission_rules` holds eligibility and amount expressions,
  parameters and effective dates. Change a supported commission rule through those records;
  retain the evaluator and accounting invariants in source.

These are examples of the decision criteria, not mandatory domain structures. Check the current
template source and downstream references before applying the same boundary elsewhere.

## Review the result

For each proposed model, state the identity or behaviour requiring it. For each removed model,
state where its validation, authority, history and references now live. Verify a normal change,
an invalid configuration and a locked or unauthorized change through the actual write path. Use
the model's normal table, guarded writes, automation controls and syncs to manage it; add charts only when they
answer a stated operational question that changes a decision.
