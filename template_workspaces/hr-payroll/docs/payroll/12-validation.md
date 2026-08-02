# 12 — Validation

This is a canonical chapter of the payroll architecture.

Three gates. Nothing reaches an employee that has not passed all three.

| gate              | when                                             | blocks     |
| ----------------- | ------------------------------------------------ | ---------- |
| A — configuration | a jurisdiction or company catalogue is activated | activation |
| B — run guard     | a run is asked to calculate                      | the run    |
| C — result        | after calculation, before approval               | approval   |

---

## Gate A — configuration

Needs no employee data.

### A1 · The treatment grid is decided

Rows are generated, so no cell is ever _missing_ — chapter [02](02-data-model.md) §7. What gate A
checks is that none is still **undecided**.

```
SELECT count(*) FROM contribution_treatments
 WHERE treatment->>'kind' = 'UNSET'
   AND statutory_contribution_id IN (this jurisdiction's contributions)
   AND effective_range @> the activation date
```

> BLOCKED — _"MY has 3 undecided cells: SHARE_GAIN × EPF, SHARE_GAIN × SOCSO, SHARE_GAIN × EIS."_

For every treatment of kind `SPECIAL`, the named rule must exist on that contribution.

> BLOCKED — _"BONUS × PCB = SPECIAL(ADDITIONAL_REMUNERATION), but PCB defines no such rule."_

A cell present twice is not checked here: the exclusion constraint made it impossible at `INSERT`.

### A2 · The overtime rule set is fully mapped

For every `overtime_rules` row in this jurisdiction, exactly one pay component of this company must
map to it.

> BLOCKED — _"MY defines REST_DAY 0–0.5 (half a day's wages); this company has no component for it.
> Rest-day work under four hours would be unpaid."_

For every component with `definition.source = OVERTIME`, `definition.minimum` — when set — must be at
least the statutory multiple.

> BLOCKED — _"OT_1_5 sets a minimum of 1.25 against a statutory 1.5. A company may pay more than
> statute, never less."_

### A3 · References resolve

| reference                                 | must                                      |
| ----------------------------------------- | ----------------------------------------- |
| `pay_components.component_type_id`        | exist                                     |
| `leave_types.payroll_effect.component_id` | exist, and its type's nature is `ABSENCE` |
| `accrual_bands.leave_code`                | match a `leave_types.code`                |
| `statutory_contributions.relief_for`      | exist                                     |
| `pay_components.definition.cap.matrix`    | be a band table that exists               |
| `pay_components.definition.rule`          | match an `overtime_rules` row             |
| `jurisdictions.ordinary_rate_divisor`     | be present and greater than zero          |

### A4 · Formulas

- every token is in the closed list (chapter [05](05-payroll-run.md) §5)
- every `component('CODE')` names a component in this company
- every `fact('CONTRIB','key')` names a live contribution
- every `band('table', …)` names a table that exists
- ordering: if X's formula reads `component('Y')`, then `type(Y).sequence < type(X).sequence`

> BLOCKED — _"OT_1_5 (OVERTIME, 400) reads HOURLY_RATE, which is typed FIXED_ALLOWANCE (200) — it
> should be INFORMATION (10)."_

- no cycle in component → component
- no cycle in contribution → `relief_for` → contribution

### A5 · Bands are well formed

Overlaps are already impossible — every effective-dated table carries an exclusion constraint (chapter
[02](02-data-model.md) §7). What gate A checks is the complement: **gaps**.

`contribution_rates`, per contribution: selectors cover the range with no gap, exactly one has
`to = null`, and `WAGE_AND_AGE` age ranges cover `[0, ∞)`.

`accrual_bands`, per owner and leave code: `SERVICE_MONTHS` starts at 0 and is strictly increasing;
`FLAT` has exactly one row.

```
✓  0 ──── 24 ──── 60 ──── ∞
✗  0 ──── 24      60 ──── ∞      gap — caught here
✗  0 ──── 30 ─ 24 ────── ∞       overlap — rejected at INSERT, never reaches this gate
```

### A6 · Effective dating leaves no gap

Overlap is impossible by constraint. A gap is not, and is checked per identity key.

```
✓  [2024-01-01, 2026-07-01) │ [2026-07-01, ∞)
✗  [2024-01-01, 2026-07-01) │ [2026-08-01, ∞)     one month unruled
✗  [2024-01-01, 2026-08-01) │ [2026-07-01, ∞)     rejected at INSERT
```

### A7 · Statutory floors are reachable

For every leave code with statutory `accrual_bands`, a company `leave_types` row exists or the company
is explicitly exempt.

> WARNING — _"MY mandates ANNUAL leave; this company has no ANNUAL leave type. Employees will accrue
> nothing."_

---

## Gate B — run guard

### The run

- lifecycle is `DRAFT`
- the previous period is `PAID`
- configuration for the period end resolves and passed gate A

### Attendance

- no time entries in the window are `OPEN` → **BLOCKED**, listing employments and dates
- no leave ledger rows overlapping the window are still stamped → **WARNING**, they will be excluded

### Per employment

- `employment_terms` effective for the whole period, no gap
- `date_of_birth` present where a contribution is keyed by age → **BLOCKED**
- `hire_date` present

`employment_statutory_facts` is not required. An absent row means registered with no reference number
captured; a missing reference number blocks the filing, not the run.

### Per entry

- the pay component resolves in the period's configuration
- `origin: REVERSAL` names an entry consumed by a settled run
- `origin: INSTALMENT` names an agreement that exists and is not settled
- `definition.settlement = PAYROLL` ⇒ `pay_period` is set
- `definition.settlement = COMPANY_DIRECT` ⇒ `pay_period` is null

Approval is not checked here: a stamped entry is invisible to the query, never an error.

---

## Gate C — result

Arithmetic identities, not opinions.

### Per payslip

| #   | identity                                                                             |
| --- | ------------------------------------------------------------------------------------ |
| C1  | `gross = Σ EARNING lines − Σ ABSENCE lines`                                          |
| C2  | `net = gross − Σ employee_amount − Σ DEDUCTION lines + Σ NON_WAGE_PAYMENT lines`     |
| C3  | `employer_cost = Σ employer_amount + Σ EMPLOYER_COST lines`                          |
| C4  | `net ≥ 0`                                                                            |
| C5  | replaying the grid over `payslip_lines` reproduces every `base_amount` exactly       |
| C6  | every line links to its source entry, or is derived and names the inputs it consumed |
| C7  | no line has a negative amount                                                        |

### Per run

| #   | identity                                                                         |
| --- | -------------------------------------------------------------------------------- |
| C8  | every employment active in the period has exactly one payslip                    |
| C9  | `Σ payslips.net` equals the bank file total                                      |
| C10 | `Σ payslip_contributions` per contribution equals that contribution's file total |
| C11 | every reference number needed by a filing is present, or the filing is flagged   |

### Warnings, not blocks

- overtime hours exceed the statutory monthly limit
- net pay fell more than 30% against the prior period
- a contribution's base is zero while gross is not
- a leave balance is negative
- a claim was approved over its cap with `on_exceed = ALLOW`

---

## Continuous invariants

### Ledger

| #   | invariant                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------ |
| L1  | `leave_ledger` rows are never updated or deleted                                                                   |
| L2  | a `TAKEN` row exists for every day of every leave request and no other day; request and rows share one approval id |
| L3  | only `TAKEN`, `ADJUSTMENT` and `ENCASHMENT` rows exist — accrual, carry-forward and expiry are derived             |
| L4  | the projected balance is ≥ 0 unless the leave type permits advance leave                                           |
| L5  | no ledger row exists for a leave type the person is not eligible for                                               |

### Entries

| #   | invariant                                                                               |
| --- | --------------------------------------------------------------------------------------- |
| E1  | an entry consumed by a settled run is never updated                                     |
| E2  | a reversal reverses exactly one entry, and only once                                    |
| E3  | Σ approved claim entries in a cap period ≤ the resolved cap, unless `on_exceed = ALLOW` |

### Structure

| #   | invariant                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------- |
| S1  | proration appears in exactly one place: `jurisdictions.proration`. No formula contains `employed_days / calendar_days` |
| S2  | every component whose unit is not MONEY has type `INFORMATION`                                                         |
| S3  | no contribution row has a `wage_floor` or `wage_ceiling` column                                                        |
| S4  | composition is `max(statutory, company) + Σ individual` everywhere — leave entitlement and claim caps alike            |
| S5  | no model named `*_leave_plans`, `*_segments` or `corrects_*` exists                                                    |
| S6  | no value is maintained by a scheduled or background process                                                            |
| S7  | no overtime multiplier, rate divisor or statutory limit appears in a company row or a formula                          |
| S8  | no pay component carries a statutory flag of any kind                                                                  |
| S9  | no company-level row states a contribution treatment                                                                   |
| S10 | no payroll model declares an approval field, approver, or pending/rejected status                                      |
| S11 | every variant column parses against its union; an unknown discriminator or missing required field is rejected at write |
| S12 | no table carries a column meaningless for some of its rows                                                             |
| S13 | every effective-dated table has an exclusion constraint on its identity plus range overlap                             |
| S14 | `contribution_treatments` has one row per (type × contribution) per date — generated, never sparse                     |
| S15 | generated provenance keys are read-only projections of their JSON variant and retain foreign-key integrity             |

---

## What blocks what

| condition                        | blocks                         |
| -------------------------------- | ------------------------------ |
| an undecided (`UNSET`) treatment | jurisdiction activation        |
| a duplicate treatment            | nothing — rejected at `INSERT` |
| unmapped overtime rule           | company activation             |
| dangling reference               | activation                     |
| formula ordering violation       | company activation             |
| band gap or overlap              | jurisdiction activation        |
| overlapping effective ranges     | saving the row                 |
| open time entry                  | the run                        |
| missing date of birth            | the run                        |
| unsettled previous period        | the run                        |
| failed arithmetic identity       | approval                       |
| negative net                     | approval                       |
| missing filing reference number  | the filing                     |
| overtime over the legal limit    | nothing — warns                |
