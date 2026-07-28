# 05 — The payroll run

Eight steps, the same eight for every country.

---

## 1. The pipeline

| #   | step       | does                                                                                                                                          |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | PICK       | resolve the jurisdiction, contributions, rates, grid, overtime rules and the company's components as of the period end → `configuration_hash` |
| 2   | VALIDATE   | no employee data needed — chapter [12](12-validation.md). Blocked on failure                                                                  |
| 3   | GATHER     | per employment: entries for the period, leave taken in the window, time entries in the window                                                 |
| 4   | MEASURE    | in component-type sequence, produce amounts → `payslip_lines`                                                                                 |
| 5   | ACCUMULATE | each line through the grid → contribution bases                                                                                               |
| 6   | CONTRIBUTE | each contribution in sequence: base → employee and employer amounts                                                                           |
| 7   | SETTLE     | gross, total deductions, net, employer cost                                                                                                   |
| 8   | PERSIST    | payslip, lines, contributions, each line linked to its source                                                                                 |

Step 5 never names EPF. Step 6 never names overtime. Neither knows Malaysia.

---

## 2. Period, cutoff and window

A company has a **pay period** (the calendar month wages belong to) and an **attendance window** (the
work days those wages cover). They are not the same range.

```
Nihon: pay_cutoff_day 21, pay_day 25

  Dec                        Jan                        Feb
───┼───────────┼─────────────┼───────────┼──────────────┼───►
   1          21             1          21              1
              └──── attendance window ───┘
                    22 Dec  →  21 Jan
                                          pay period 2026-01, paid 25 Jan
```

| input             | selected by                           |
| ----------------- | ------------------------------------- |
| time entries      | `work_date` in the attendance window  |
| leave taken       | leave date in the attendance window   |
| component entries | `pay_period`                          |
| salary proration  | employment days in the calendar month |

`pay_period` defaults from `event_date` and the cutoff, and is overridable:

| event date               | day vs cutoff | pay period |
| ------------------------ | ------------- | ---------- |
| 2026-01-08               | 8 ≤ 21        | 2026-01    |
| 2026-01-25               | 25 > 21       | 2026-02    |
| 2026-01-25 with override | —             | 2026-01    |

---

## 3. Measuring

Four input modes, one per pay component, set by `definition.source`.

| source     | produces                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------ |
| `ENTRY`    | the entry's amount; prorated when `origin.kind = STANDING`                                 |
| `FORMULA`  | the evaluated expression                                                                   |
| `OVERTIME` | hours × the statutory multiple for the mapped rule (chapter [06](06-time-and-overtime.md)) |
| `SCHEDULE` | the instalment whose `pay_period` matches                                                  |

Order is `component_types.sequence`, so the hourly rate exists before overtime needs it, and every
earning exists before step 5 sums them.

```
  10  INFORMATION      19.23 hourly rate · 10.0 OT hours
 100  BASIC_SALARY   4,000.00
 200  FIXED_ALLOWANCE  200.00  150.00  150.00
 400  OVERTIME         288.45   reads the INFORMATION components
1000  UNPAID_ABSENCE     0.00
1300  LOAN_REPAYMENT   167.00
1500  REIMBURSEMENT     93.50
```

---

## 4. Proration

An amount is prorated when the employment — or the entry's own `effective_range` — covers only part of
the period.

| prorates                               | does not          |
| -------------------------------------- | ----------------- |
| `BASIC_SALARY`, by employment dates    | a one-off claim   |
| an entry with `origin.kind = STANDING` | a bonus           |
|                                        | a loan instalment |

The divisor comes from `jurisdictions.proration` and nothing else:

| method          | divisor                                         |
| --------------- | ----------------------------------------------- |
| `CALENDAR_DAYS` | employed calendar days / calendar days in month |
| `WORKING_DAYS`  | employed working days / working days in month   |
| `FIXED_DAYS`    | employed days / fixed days (e.g. 26)            |

Siti joins 12 January, salary 3,000, transport 150 standing, medical claim 93.50, calendar days:

| line      | calculation   | amount   |
| --------- | ------------- | -------- |
| BASIC     | 3,000 × 20/31 | 1,935.48 |
| TRANSPORT | 150 × 20/31   | 96.77    |
| MEDICAL   | one-off       | 93.50    |

There is no `prorates` flag on a pay component and no proration arithmetic inside a formula. `BASIC`'s
formula is `terms.base_salary`; the engine prorates the result.

### A change mid-period

Ahmad's salary rises from 4,000 to 4,600 on 16 January. `employment_terms` has two rows. Proration
applies to each and the amounts sum:

```
 1–15 Jan   4,000 × 15/31 = 1,935.48
16–31 Jan   4,600 × 16/31 = 2,374.19
                            ─────────
payslip line BASIC          4,309.67
```

Bases accumulate once, on the summed line. There is no separate segment concept.

---

## 5. The formula language

Closed. Every token is checked at validation.

| token                                                                       | resolves to                                                          |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `component('CODE')`                                                         | an already-measured component's amount                               |
| `entry('CODE')`                                                             | this employment's entry amount for a component                       |
| `fact('CONTRIB','key')`                                                     | an `employment_statutory_facts` value                                |
| `terms.*`                                                                   | `base_salary`, `ordinary_hours_per_week`, `working_days_per_week`    |
| `derived.*`                                                                 | `service_months`, `age`, `employed_days`, `headcount`                |
| `period.*`                                                                  | `start`, `end`, `calendar_days`, `working_days`, `periods_remaining` |
| `jurisdiction.*`                                                            | `ordinary_rate_divisor`, `ordinary_rate_basis`                       |
| `leave.days(code)`, `leave.balance(code)`                                   | from the ledger                                                      |
| `band('table', key, 'column')`                                              | a rate or accrual band lookup                                        |
| `round`, `ceil`, `floor`, `min`, `max`, `clamp`, `coalesce`, `sum`, `count` | pure operations                                                      |

Nihon's formulas in full:

```
HOURLY_RATE   round(terms.base_salary / jurisdiction.ordinary_rate_divisor
                    / (terms.ordinary_hours_per_week / terms.working_days_per_week), CENT)
              type INFORMATION, sequence 10

BASIC         terms.base_salary
              the engine prorates it — §4. The formula never does.

NPL           round(leave.days('UNPAID')
                    × round(terms.base_salary / period.calendar_days, CENT), CENT)
```

`NPL` returns a positive number. Its type is `UNPAID_ABSENCE`, whose nature is `ABSENCE`, so it
subtracts from gross, and whose grid row is `REDUCE`, so it shrinks every base. The formula carries no
minus sign.

Overtime components have no formula at all: the multiplier comes from `overtime_rules`.

---

## 6. Eligibility

`pay_components.eligibility` is a rule list; all must match, and no rules means everyone.

`OT_1_5` requires `work_classification IN [MANUAL, NON_MANUAL]` and `overtime_eligible = true`.

| person                      | matches | result                                            |
| --------------------------- | ------- | ------------------------------------------------- |
| Ahmad, NON_MANUAL, eligible | yes     | measured, line written                            |
| Faridah, MANAGERIAL         | no      | **not processed** — no line, no feed, no zero row |

An ineligible component produces nothing at all. That is what keeps `ot_eligible ? … : 0` out of
formulas.

---

## 7. Settlement

From `component_types.nature`:

```
gross            = Σ EARNING − Σ ABSENCE                        = 4,788.45
statutory (ee)   = Σ payslip_contributions.employee_amount      =   624.70
other deductions = Σ DEDUCTION lines                            =   167.00
payments         = Σ NON_WAGE_PAYMENT lines                     =    93.50

net              = gross − statutory − other + payments         = 4,090.25
employer cost    = Σ employer_amount + Σ EMPLOYER_COST lines    =   720.65
```

### The negative-net guard

If net would go below zero, deductions are reduced in reverse component-type sequence until net is
zero, and the shortfall carries forward as an arrears entry on the next period.

| type                    | reducible                                       |
| ----------------------- | ----------------------------------------------- |
| `OTHER_DEDUCTION`       | reduced first                                   |
| `LOAN_REPAYMENT`        | reduced next; the agreement extends by a period |
| `STATUTORY_ORDER`       | never — court-ordered                           |
| statutory contributions | never                                           |

Reducibility is `definition.reducible` on the pay component, so a court order cannot be shrunk by
policy.

---

## 8. Lifecycle

```
 DRAFT ──mark paid──► PAID
   │
   └──── recalculate

The platform gates both draft revisions and the transition to `PAID` through its standard approval,
access-control, and audit protocol.
```

| state   | means                                                                             |
| ------- | --------------------------------------------------------------------------------- |
| `DRAFT` | editable and recalculable; entries may still arrive                               |
| `PAID`  | immutable; changes require a compensating entry (chapter [11](11-corrections.md)) |

### Guards before calculating

- run lifecycle is `DRAFT`
- no time entries in the attendance window are `OPEN`
- every employment has terms effective for the whole period
- `date_of_birth` present where a contribution is keyed by age
- the previous period is `PAID`

---

## 9. Background work

There is none. Leave accrual, carry-forward, expiry and cap consumption are all derived when read
(chapters [07](07-leave.md) and [08](08-claims.md)). The only thing that runs is a payroll run, and a
person starts it.
