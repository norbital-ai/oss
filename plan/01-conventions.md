# 01 — Conventions

Three rules every later chapter obeys: where a fact lives, how approval works, and how variation is
modelled.

---

## 1. Levels

Every row lives at exactly one level. The level answers: who is this true for?

| level        | models                                                                                                                                                      | who writes it          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| GLOBAL       | `component_types`                                                                                                                                           | product, once          |
| JURISDICTION | `jurisdictions`, `statutory_contributions`, `contribution_rates`, `contribution_treatments`, `overtime_rules`, `overtime_limits`, statutory `accrual_bands` | product, per country   |
| COMPANY      | `companies`, `pay_components`, `leave_types`, company `accrual_bands`, `shift_definitions`, `company_holidays`                                              | the customer           |
| EMPLOYMENT   | `employment_terms`, `employment_statutory_facts`                                                                                                            | HR                     |
| EVENT        | `component_entries`, `leave_requests`, `leave_ledger`, `time_entries`, `roster_entries`, `repayment_agreements`                                             | anyone doing their job |

**The rule: declare a fact at the highest level at which it is true.** A lower level may narrow or
exceed it; never contradict it.

The test: _if I add a second company in this country, would I write this row again?_ If yes, it
belongs one level up.

### What the rule prevents

| mistake                           | consequence                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------- |
| component types at COMPANY level  | 500 customers × 17 types, and 500 different answers to "is overtime EPF-liable?" |
| treatments at COMPANY level       | every customer restates the EPF Act; an amendment means editing 500 customers    |
| statutory minima at COMPANY level | a customer deletes theirs and staff accrue nothing legal                         |
| salary at COMPANY level           | a fact true of one person declared as true of everyone                           |

### The one-way wall

A company may read across the jurisdiction boundary. It may never write across it.

`pay_components` has no `epf` field, no `taxable`, no `statutory_eligibility`, no `feeds`, no
multiplier and no rate. There is no field in which a company could write a statutory opinion. The wall
is enforced by the absence of a column, not by a permission rule.

Two customers both creating "Transport Allowance" is not duplication — each row has its own name and
amount policy. What must not be duplicated is the statutory answer, and it is not: both point at the
same `FIXED_ALLOWANCE` type.

---

## 2. Approval

The platform provides it. Every table has `norbital_approval_id` as a system column. Payroll does not
define approver routing, steps, pending flags or rejected states.

Forbidden in any payroll model: `approval_id`, `approved_by`, `approved_at`, `status: PENDING`,
`status: APPROVED`, `status: REJECTED`, `approval_workflow`.

### Write-then-lock

The record is written first, then stamped. There is no draft table and no staging area.

```
user submits a claim
      │
      ▼
component_entries row INSERTED immediately
norbital_approval_id = <request id>          the row exists, is visible, is immutable
      │
      ├── approved ──►  norbital_approval_id set to NULL; the row stands
      │
      └── rejected ──►  the temporal ledger restores the row's pre-approval
                        state, or deleted if it was a create
```

### Two states

| `norbital_approval_id` | meaning                                       |
| ---------------------- | --------------------------------------------- |
| not null               | pending — locked, immutable                   |
| null                   | in force — approved, or never needed approval |

There is no rejected state, because rejection undoes the write. "Show me rejected claims" is a
question for the platform's approval-request history, not the payroll tables.

### How payroll reads it

One predicate, everywhere: `WHERE norbital_approval_id IS NULL`. An unapproved row is invisible, not
conditionally handled. There is no `if (approved)` in the engine.

### Settled and projected

Because writes happen before approval, two balances exist, and using the wrong one causes overdrafts.

| balance       | predicate             | used by                                                     |
| ------------- | --------------------- | ----------------------------------------------------------- |
| **settled**   | `approval_id IS NULL` | payroll — never acts on an unapproved row                   |
| **projected** | every row             | a new request or claim — pending items reserve their budget |

Ahmad has 7.0 days settled and a 3-day request pending. He asks for 5 more.

- Checked against settled: `7.0 ≥ 5.0` → allowed. Both approve, he is 1.0 day overdrawn.
- Checked against projected: `4.0 < 5.0` → refused.

The same pair applies to claim caps: a cap check counts pending claims; payroll and reporting count
only settled ones.

### States payroll may still keep

A state describing what the engine has done is not an approval mechanism. One describing who said yes
is.

| kept                                              | removed                         |
| ------------------------------------------------- | ------------------------------- |
| `payroll_runs.lifecycle` — `DRAFT → PAID`         | `payroll_runs.state = APPROVED` |
| `time_entries.state` — `OPEN`/`CLOSED`, the clock | `leave_requests.state`          |

A run is authorised for payment when its record's approval stamp clears; the lifecycle then moves to
`PAID`.

### Cancelling an approved record

A cancellation is a delete, and the delete is itself approval-stamped: approved removes the rows,
rejected restores them from the temporal ledger. For rows already consumed by a `PAID` run, deletion is refused
— the correction is a compensating entry (chapter [11](11-corrections.md)).

---

## 3. Variants

**A field must be meaningful for every row of its table.** A field meaningless for some rows belongs
in a discriminated union, not a nullable column.

Two kinds of null, and only one is acceptable:

| kind                    | example                                                                                                                    | verdict             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| empty but meaningful    | `leave_types.carry_limit_days = null` — "how many days carry forward?" → "none". The question applies to every leave type. | keep the column     |
| meaningless when absent | `pay_components.formula = null` — "what is the formula?" is nonsense for an entry-driven component.                        | move into a variant |

The test: read the column name as a question and ask it of every row. If it is nonsense for some rows,
the column is in the wrong place.

### Shape

A variant is a validated object with a discriminator as its first key. Every field inside an arm is
required.

```
pay_components
  company_id · code · name · component_type_id · eligibility · effective_range
  definition:  { source: 'ENTRY',    … }
             | { source: 'FORMULA',  … }
             | { source: 'OVERTIME', … }
             | { source: 'SCHEDULE', … }
```

A `FORMULA` component _has_ an expression — not "may have". The schema rejects one without it, and no
`ENTRY` component carries a formula column it cannot use.

### Why not a table per variant

| option                        | problem                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| four tables                   | every foreign key to "a pay component" becomes four keys or a polymorphic reference |
| one table, nullable columns   | 60% of columns null on any row, nothing enforcing which                             |
| one table, one variant column | one identity, one foreign key, shape enforced at write                              |

The variant describes _how the amount is obtained_. What the thing **is** stays `component_type_id`, a
plain column, because it is true of every row.

### Where variants are used

| model                        | variant                     | replaces                                                                              |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| `jurisdictions`              | `proration`                 | `proration_fixed_days`                                                                |
| `statutory_contributions`    | —                           | —                                                                                     |
| `contribution_rates`         | `selector`, `award`         | five sparse numerics keyed off `method`                                               |
| `contribution_treatments`    | `treatment`                 | `special_rule`, null on 79 of 80 rows                                                 |
| `overtime_rules`             | `band`, `award`             | `measure`/`unit`/`basis` reinterpreting `value`                                       |
| `accrual_bands`              | `owner`, `key`              | two mutually exclusive foreign keys                                                   |
| `pay_components`             | `definition`                | `input`, `formula`, `cap`, `settlement_route`, `overtime_rule`, `multiplier_override` |
| `leave_types`                | `accrual`, `payroll_effect` | carry fields on per-event types; `unpaid_component_id` on paid types                  |
| `employment_statutory_facts` | `status`                    | `reference_number` on unregistered rows                                               |
| `component_entries`          | `origin`                    | `source`, `source_id`, `effective_range`, `evidence_file`, `reverses_entry_id`        |
