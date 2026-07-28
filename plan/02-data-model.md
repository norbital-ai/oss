# 02 — Data model

26 models. Every table also carries the platform's system columns: `norbital_id`,
`norbital_created_at`, `norbital_updated_at`, `norbital_row_version`, `norbital_sys_period`,
`norbital_approval_id`. No model below declares an approval field.

---

## Relations

```
JURISDICTION                                    COMPANY
 jurisdictions                                   companies
   ├── statutory_contributions                     ├── pay_components ──┐
   │     └── contribution_rates                    ├── leave_types      │
   ├── overtime_rules                              ├── accrual_bands    │
   ├── overtime_limits                             ├── shift_definitions│
   └── accrual_bands (statutory)                   └── company_holidays │
                                                                        │
GLOBAL                                                                  │
 component_types ◄────── contribution_treatments ───────────────────────┘
                            (type × contribution)

PEOPLE                              EVENTS
 employees                           component_entries ◄── repayment_agreements
   └── employments ──────────────┬── leave_requests ──► leave_ledger
         ├── employment_terms    ├── roster_entries ──► time_entries
         └── employment_statutory_facts

RESULTS
 payroll_runs ──► payslips ──┬── payslip_lines
                             └── payslip_contributions
```

---

## 1. Statutory — 8 models

### `jurisdictions`

| field                                            | notes                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `code`                                           | `MY`, `MY-SARAWAK`, `SG`, `ID`                                                                                            |
| `name`, `currency`                               |                                                                                                                           |
| `tax_year_start_month`, `leave_year_start_month` | 1–12                                                                                                                      |
| `proration`                                      | variant: `{by: CALENDAR_DAYS}` · `{by: WORKING_DAYS}` · `{by: FIXED_DAYS, days}` — the only place proration is configured |
| `rounding`                                       | `NEAREST_CENT` · `TRUNCATE_CENT` · `UP_5_CENTS`                                                                           |
| `ordinary_rate_basis`                            | `DAYS_PER_MONTH` · `HOURS_PER_MONTH`                                                                                      |
| `ordinary_rate_divisor`                          | MY 26 days (EA s.60I) · ID 173 hours (PP 35/2021) · SG 190.67 hours                                                       |
| `effective_range`, `definition_hash`             | the hash covers the whole ruleset                                                                                         |

### `statutory_contributions`

One row per scheme per jurisdiction. Malaysia has five, Singapore two, Indonesia six.

| field                                          | notes                                                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `jurisdiction_id`, `code`, `name`, `authority` |                                                                                                                |
| `payer`                                        | `EMPLOYEE` · `EMPLOYER` · `BOTH`                                                                               |
| `keyed_by`                                     | `WAGE` · `WAGE_AND_AGE` · `HEADCOUNT` · `RISK_CLASS`                                                           |
| `rounding`                                     | `NONE` · `NEAREST_CENT` · `UP_TO_UNIT` · `TABLE`                                                               |
| `relief_for`                                   | contributions whose computation treats this one's employee share as a relief. Empty means it relieves nothing. |
| `sequence`                                     | calculation order                                                                                              |
| `effective_range`                              |                                                                                                                |

No `wage_floor` or `wage_ceiling`: a floor is the first band, a ceiling is the terminal band.

### `contribution_rates`

One row per band. `statutory_contribution_id` · `effective_range` · `selector` · `award`.

```
selector — what picks this row
  { by: 'WAGE',         from, to }          to null = terminal
  { by: 'WAGE_AND_AGE', from, to, age_from, age_to }
  { by: 'HEADCOUNT',    from, to }
  { by: 'RISK_CLASS',   class }

award — what it pays
  { kind: 'PERCENT',     employee, employer }
  { kind: 'FIXED',       employee, employer }     tabled amounts
  { kind: 'PROGRESSIVE', rate, constant }         a tax scale row
```

### `component_types`

A physical table, seeded, closed to customers. Not a database enum: `pay_components` and
`contribution_treatments` hold foreign keys to it. Only product may insert rows, and an insert is
inert until the grid is completed for every live jurisdiction.

`code` · `name` · `nature` · `sequence` · `description`

`nature` is a true enum — `INFORMATION`, `EARNING`, `ABSENCE`, `DEDUCTION`, `NON_WAGE_PAYMENT`,
`EMPLOYER_COST` — because the settlement arithmetic switches on it.

### `contribution_treatments`

The grid. One row per (component type × statutory contribution) per effective range.

`component_type_id` · `statutory_contribution_id` · `authority` · `effective_range` · `treatment`.

```
treatment
  { kind: 'INCLUDE' }          adds to the base
  { kind: 'EXCLUDE' }          does not touch the base
  { kind: 'REDUCE' }           subtracts from the base
  { kind: 'SPECIAL', rule }    a named rule on that contribution handles it
  { kind: 'UNSET' }            generated, never authored — §7
```

Rows are **generated**, not authored: adding a component type, a contribution or a jurisdiction
materialises the missing cells as `UNSET`. A cell is therefore never absent, only undecided, and
`UNSET` blocks activation. §7.

### `overtime_rules`

What overtime is worth. `jurisdiction_id` · `day_type` · `authority` · `effective_range` · `band` ·
`award`.

```
band — how the range is measured
  { measure: 'BEYOND_NORMAL',     from_hours, to_hours }        to null = open
  { measure: 'FROM_START_OF_DAY', from_fraction, to_fraction }  of normal hours

award — what the band pays
  { kind: 'HOURLY_MULTIPLE',   multiple }   hours in band × multiple × ORP
  { kind: 'DAY_WAGE_MULTIPLE', multiple }   multiple × one day's wages, flat
```

`day_type` is `ORDINARY`, `REST_DAY` or `PUBLIC_HOLIDAY`.

### `overtime_limits`

`jurisdiction_id` · `period` (`DAY`/`WEEK`/`MONTH`) · `max_hours` · `on_exceed` (`WARN`/`BLOCK`) ·
`authority` · `effective_range`.

### `accrual_bands`

Leave entitlement. `leave_code` · `days` · `authority` · `effective_range` · `owner` · `key`.

```
owner
  { level: 'STATUTORY', jurisdiction_id }
  { level: 'COMPANY',   company_id }

key
  { by: 'SERVICE_MONTHS', band_from }   one row per service band
  { by: 'FLAT' }                        one row; every eligible person gets the same
```

---

## 2. Company — 5 models

### `companies`

`jurisdiction_id` · `name` · `registration_number` · `pay_cutoff_day` · `pay_day` ·
`leave_year_start_month` · `risk_class` · `effective_range`

Headcount is derived from active employments, never stored.

### `pay_components`

The customer's catalogue. Carries no statutory flag of any kind.

| column                       | notes                                          |
| ---------------------------- | ---------------------------------------------- |
| `company_id`, `code`, `name` |                                                |
| `component_type_id`          | what this is — the only chargeability surface  |
| `eligibility`                | rule list; all must match, none means everyone |
| `effective_range`            |                                                |
| `definition`                 | how the amount is obtained — variant below     |

```
{ source: 'ENTRY' }        a person states an amount
    unit         MONEY | DAYS | HOURS
    evidence     NONE | OPTIONAL | REQUIRED
    cap          Cap | null              null = uncapped
    settlement   PAYROLL | COMPANY_DIRECT

{ source: 'FORMULA' }      the engine computes it
    unit         MONEY | DAYS | HOURS | RATE
    expr         chapter 05 §5

{ source: 'OVERTIME' }     a statutory overtime rule pays it
    rule         { day_type, measure, band_from } → an overtime_rules row
    minimum      number | null    an override that may only raise the statutory
                                  multiple (R3)

{ source: 'SCHEDULE' }     an agreement generates instalments
    unit         MONEY
    reducible    may the negative-net guard shrink it? false for court orders
```

### `leave_types`

| column                            | notes                                     |
| --------------------------------- | ----------------------------------------- |
| `company_id`, `code`, `name`      |                                           |
| `eligibility`                     | who gets this type at all — chapter 07 §2 |
| `aggregates_with`                 | shares a cap; hospitalisation with sick   |
| `encash_on_exit`                  |                                           |
| `requires_certificate_after_days` | null = never                              |
| `effective_range`                 |                                           |
| `accrual`                         | variant                                   |
| `payroll_effect`                  | variant                                   |

```
accrual
  { kind: 'MONTHLY',   carry: { limit_days, expiry_months } | null }
  { kind: 'UPFRONT',   carry: { limit_days, expiry_months } | null }
  { kind: 'PER_EVENT' }                    no balance, no carry, no expiry

payroll_effect
  { kind: 'PAID' }                         no payroll effect
  { kind: 'UNPAID', component_id }         the UNPAID_ABSENCE pay component
```

### `shift_definitions`

`company_id` · `code` · `name` · `start_time` · `end_time` · `break_minutes` · `crosses_midnight` ·
`effective_range`

### `company_holidays`

`company_id` · `date` · `name` · `scope` · `location_codes`

---

## 3. People — 4 models

### `employees`

`name` · `date_of_birth` · `gender` · `marital_status` · `nationality` · `identity_number` ·
`dependents_count`

### `employments`

`employee_id` · `company_id` · `employee_number` · `hire_date` · `exit_date` · `exit_reason` ·
`effective_range`

`hire_date` drives service months and every leave accrual. Correcting it changes derived history —
chapter [11](11-corrections.md) §4.

### `employment_terms`

Effective-dated. `employment_id` · `base_salary` · `pay_frequency` · `ordinary_hours_per_week` ·
`working_days_per_week` · `work_classification` · `employment_type` · `overtime_eligible` ·
`effective_range`

### `employment_statutory_facts`

One row per contribution. `employment_id` · `statutory_contribution_id` · `effective_range` ·
`status`.

```
status
  { kind: 'REGISTERED',     reference_number, rate_override: number | null }
  { kind: 'NOT_REGISTERED', reason }
```

An absent row means registered with no reference number captured. A missing reference number blocks
the filing, not the run.

---

## 4. Events — 6 models

### The three input planes

There is no universal input table, because the three things that happen have three different units.
There is a universal converter and a universal output.

```
WHAT HAPPENED                THE CONVERTER            THE RESULT

component_entries   money ─┐
  claim · bonus ·          │
  allowance · instalment   │
                           ├──►  pay_components  ──►  payslip_lines
leave_ledger         days ─┤     definition.source      always MONEY
  TAKEN rows               │     decides which          always typed
                           │     plane it reads
time_entries       clocks ─┘
  + roster_entries
```

| `definition.source` | reads                                                |
| ------------------- | ---------------------------------------------------- |
| `ENTRY`, `SCHEDULE` | `component_entries`                                  |
| `FORMULA`           | `leave_ledger`, terms, other components              |
| `OVERTIME`          | `time_entries` + `roster_entries` + `overtime_rules` |

Only `component_entries` holds money. The other two hold measurements; a pay component converts a
measurement into money. A clock is two timestamps and a leave day is a signed quantity — neither fits
an `amount` column without most of every row being null.

What the three planes share: all are EVENT level, all carry `norbital_approval_id`, all are read
`WHERE approval IS NULL`, all reach a payslip line through a pay component and therefore a component
type, and all are linked back from the line they produced.

### `component_entries`

The only door money enters payroll through.

| column             | notes                                                 |
| ------------------ | ----------------------------------------------------- |
| `employment_id`    |                                                       |
| `pay_component_id` | which catalogue row, hence which component type       |
| `amount`           | a magnitude, never negative                           |
| `quantity`         | null = the amount is stated directly, not measured    |
| `event_date`       | when it was incurred                                  |
| `pay_period`       | resolved settlement period; null for `COMPANY_DIRECT` |
| `origin`           | variant                                               |

```
origin
  { kind: 'STANDING',   effective_range }              a monthly allowance
  { kind: 'ONE_OFF',    note }                         a bonus, an adjustment
  { kind: 'CLAIM',      evidence_file, incurred_on }
  { kind: 'INSTALMENT', agreement_id, sequence, of }
  { kind: 'REVERSAL',   reverses_entry_id, reason }
  { kind: 'ARREARS',    covers_periods, reason }
```

Proration follows from the variant: `STANDING` prorates by the overlap of its range with the period.
Nothing else does.

Indexed on `(employment_id, pay_period)` and `(pay_component_id)`.

### `repayment_agreements`

A staff loan, a salary advance and an overpayment recovery are the same object: an agreement to deduct
a principal over time. It has an identity that outlives any instalment and a balance spanning periods.

`employment_id` · `pay_component_id` · `reference` · `principal` · `disbursed_on` ·
`schedule { instalment_amount, count, first_period }` · `effective_range`

No `state` column: an agreement is settled when its outstanding balance reaches zero, which is a
`SUM`.

### `leave_requests`

`employment_id` · `leave_type_id` · `from_date` · `to_date` · `days` · `half_day_start` ·
`half_day_end` · `reason` · `certificate_file`

No state column. The request and its ledger rows are written together and locked by the same approval
request.

### `leave_ledger`

Insert-only. Never updated, never deleted.

`employment_id` · `leave_type_id` · `entry_date` · `kind` (`TAKEN` · `ADJUSTMENT` · `ENCASHMENT`) ·
`days` (signed) · `source_id` · `note`

Three kinds, every one a person doing something. Accrual, carry-forward and expiry are derived —
chapter [07](07-leave.md) §7.

### `roster_entries`

`employment_id` · `work_date` · `shift_definition_id`

Optional: office staff on a fixed week have none. `day_type` is derived, not stored.

### `time_entries`

`employment_id` · `work_date` · `clock_in` · `clock_out` · `break_minutes` · `state`
(`OPEN`/`CLOSED`)

Overtime is whatever was clocked beyond the shift. Authorisation is the row's own approval stamp.

---

## 5. Results — 4 models

### `payroll_runs`

`company_id` · `period` · `lifecycle` (`DRAFT`/`PAID`) · `configuration_hash` ·
`pay_date` · `attendance_from` · `attendance_to`

Unique on `(company_id, period)`. No `corrects_run_id`: a `PAID` run is never re-run.

### `payslips`

`payroll_run_id` · `employment_id` · `gross` · `total_deductions` · `net` · `employer_cost` ·
`currency`. Unique on `(payroll_run_id, employment_id)`.

### `payslip_lines`

`payslip_id` · `pay_component_id` · `component_type_id` · `amount` · `quantity` · `rate` ·
`source_entry_id` · `sequence`

`component_type_id` is denormalised so a payslip renders and a report groups without re-resolving
configuration that may since have changed.

### `payslip_contributions`

`payslip_id` · `statutory_contribution_id` · `base_amount` · `employee_amount` · `employer_amount` ·
`band_reference`

Year-to-date is a `SUM` over these. There is no year-to-date model.

---

## 6. Conventions

**Effective dating.** Every configuration model carries `effective_range`. A run resolves everything
as of the period end date. Changing configuration means end-dating a row and inserting its successor,
never updating in place.

**Proration.** An amount is prorated when the employment, or the entry's own `effective_range`, covers
only part of the period. `BASIC_SALARY` always; `STANDING` entries by overlap; nothing else. The
divisor comes from `jurisdictions.proration`. No flag on a component, no proration arithmetic inside a
formula.

**Hashing.** `jurisdictions.definition_hash` and `payroll_runs.configuration_hash` make a payslip
replayable. Individual configuration rows are not separately hashed.

**Signs.** Amounts are magnitudes. Direction comes from the component type's nature and from the
treatment. The only signed values are `leave_ledger.days` and the `constant` inside a `PROGRESSIVE`
award.

---

## 7. Constraints

Two failure modes matter for every effective-dated table: **a cell missing** and **a cell present
twice**. They are prevented by different means.

### Duplicates — an exclusion constraint

A unique index on `(a, b, effective_range)` does not help: two rows with ranges
`[2020-01-01, 2026-07-01)` and `[2024-01-01, ∞)` are distinct values but overlap, so a lookup on
2025-01-01 finds both. What is needed is an **overlap** exclusion, which Postgres provides natively.

```sql
ALTER TABLE contribution_treatments
  ADD CONSTRAINT treatment_no_overlap
  EXCLUDE USING gist (
    component_type_id         WITH =,
    statutory_contribution_id WITH =,
    effective_range           WITH &&
  );
```

The second row is rejected at `INSERT`. The lookup can therefore return at most one row, structurally.

Every effective-dated table carries the equivalent:

| table                        | exclusion key                                                     |
| ---------------------------- | ----------------------------------------------------------------- |
| `contribution_treatments`    | type =, contribution =, range &&                                  |
| `contribution_rates`         | contribution =, **selector range &&**, effective range &&         |
| `overtime_rules`             | jurisdiction =, day_type =, **band range &&**, effective range && |
| `accrual_bands`              | owner =, leave_code =, **key band &&**, effective range &&        |
| `pay_components`             | company =, code =, range &&                                       |
| `leave_types`                | company =, code =, range &&                                       |
| `employment_terms`           | employment =, range &&                                            |
| `employment_statutory_facts` | employment =, contribution =, range &&                            |
| `statutory_contributions`    | jurisdiction =, code =, range &&                                  |

The rows in bold are two-dimensional: `contribution_rates` must not have two bands that overlap _both_
in wage range and in effective range. A band change is therefore end-date plus insert, enforced by the
database rather than by discipline.

### Absence — generate the cross-product

No relational constraint can assert _for every X, a Y exists_. So the grid is not left sparse: it is
**materialised**, and the missing state is a value rather than an absent row.

```
INSERT a component_type      ──►  one treatment row per contribution, per jurisdiction, UNSET
INSERT a statutory_contribution ──►  one treatment row per component type, UNSET
INSERT a jurisdiction        ──►  the whole column, UNSET
```

Consequences:

- a treatment row **always exists** for every pair, so the engine's lookup is total — it returns
  `Treatment`, never `Treatment | null`, and a missing decision can never be silently read as
  `EXCLUDE`
- the undecided set is **enumerable**: `SELECT … WHERE treatment->>'kind' = 'UNSET'` is the work list
- activation blocks while any `UNSET` remains (chapter [12](12-validation.md) A1)

`UNSET` is not a fifth way to treat pay. It is the absence of a decision, made visible and countable,
and it cannot reach a payroll run.

The same pattern applies to overtime mapping: a partial unique index makes a duplicate mapping
impossible, and gate A2 catches an unmapped rule.

```sql
CREATE UNIQUE INDEX overtime_rule_mapped_once
  ON pay_components (company_id, (definition->>'rule'))
  WHERE definition->>'source' = 'OVERTIME';
```

### Summary

| failure                                 | prevented by                       | when                                                  |
| --------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| two treatments for one pair on one date | exclusion constraint               | at `INSERT` — structurally impossible                 |
| no treatment for a pair                 | cross-product generation + `UNSET` | at `INSERT` of the type, contribution or jurisdiction |
| a decision never made                   | `UNSET` blocks activation          | at activation                                         |
| a decision read as absent               | the lookup is total                | never occurs                                          |
| two overtime components for one rule    | partial unique index               | at `INSERT`                                           |
| no component for a rule                 | gate A2                            | at activation                                         |
