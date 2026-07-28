# 03 — Component types and the grid

The centre of the design: a closed list of what kinds of pay exist, and a grid saying what each kind
is chargeable under.

---

## 1. Why types exist

Without types, every pay component carries its own statutory flags:

| pay component | epf | socso | eis | pcb | hrdf |
| ------------- | --- | ----- | --- | --- | ---- |
| Transport     | ✓   | ✓     | ✓   | ✓   | ✓    |
| Overtime      | ✗   | ✓     | ✓   | ✓   | ✗    |
| OT (weekend)  | ✓   | ✓     | ✓   | ✓   | ✓    |

The third row is wrong. The EPF Act has been restated four times and can be restated wrongly four
times.

With types, the law is stated once and every component inherits it:

```
pay_components              component_types        contribution_treatments
  Transport     type ──►    FIXED_ALLOWANCE  ──►   × EPF   INCLUDE
  Overtime      type ──►    OVERTIME  ──┐          × SOCSO INCLUDE   … etc
  OT (weekend)  type ──►    OVERTIME  ──┤
  Medical       type ──►    REIMBURSEMENT │        OVERTIME × EPF   EXCLUDE  ◄ stated once
                                         └──────►  OVERTIME × SOCSO INCLUDE
                                                   OVERTIME × EIS   INCLUDE
                                                   OVERTIME × PCB   INCLUDE
                                                   OVERTIME × HRDF  EXCLUDE
```

Fifteen overtime components can be created; every one is EPF-exempt. No per-row statutory entry is
made.

---

## 2. The type list

Global. "Overtime" means the same thing in Kuala Lumpur and Manila; only its treatment differs.

| seq  | code                 | nature           | what belongs here                                                    |
| ---- | -------------------- | ---------------- | -------------------------------------------------------------------- |
| 10   | `INFORMATION`        | INFORMATION      | a computed input other components read — hourly rate, overtime hours |
| 100  | `BASIC_SALARY`       | EARNING          | contractual monthly or daily wage                                    |
| 200  | `FIXED_ALLOWANCE`    | EARNING          | paid every month regardless of activity                              |
| 300  | `VARIABLE_ALLOWANCE` | EARNING          | paid on activity — attendance, meal, rest-day work                   |
| 400  | `OVERTIME`           | EARNING          | hours beyond ordinary, at a multiplier                               |
| 500  | `COMMISSION`         | EARNING          | sales-linked                                                         |
| 600  | `BONUS`              | EARNING          | annual, performance, contractual, 13th month                         |
| 700  | `BENEFIT_IN_KIND`    | EARNING          | taxed, never paid — car, accommodation                               |
| 800  | `LEAVE_ENCASHMENT`   | EARNING          | unused leave paid out                                                |
| 900  | `TERMINATION_PAY`    | EARNING          | notice, retrenchment, gratuity                                       |
| 1000 | `UNPAID_ABSENCE`     | ABSENCE          | no-pay leave, lateness                                               |
| 1100 | `SALARY_SACRIFICE`   | DEDUCTION        | pre-statutory: extra retirement, equipment                           |
| 1200 | `STATUTORY_ORDER`    | DEDUCTION        | CP38, garnishment, court order                                       |
| 1300 | `LOAN_REPAYMENT`     | DEDUCTION        | staff loan, advance recovery                                         |
| 1400 | `OTHER_DEDUCTION`    | DEDUCTION        | union dues, canteen, damages                                         |
| 1500 | `REIMBURSEMENT`      | NON_WAGE_PAYMENT | medical, dental, expenses — paid, not wages                          |
| 1600 | `EMPLOYER_BENEFIT`   | EMPLOYER_COST    | insurance premium, employer-only cost                                |

`nature` drives two things and nothing else:

| nature           | gross | net | payslip section    |
| ---------------- | ----- | --- | ------------------ |
| INFORMATION      | ·     | ·   | not shown          |
| EARNING          | +     | +   | Earnings           |
| ABSENCE          | −     | −   | Earnings, negative |
| DEDUCTION        | ·     | −   | Deductions         |
| NON_WAGE_PAYMENT | ·     | +   | Payments           |
| EMPLOYER_COST    | ·     | ·   | Employer summary   |

`INFORMATION` is what `HOURLY_RATE` and `OT_HOURS` are: real pay components with real formulas that
other components read, but not money, so the grid does not apply and they never reach a payslip.

### When a type earns its place

A new type is justified only if some jurisdiction treats it differently from every existing type, or
some statutory form reports it on its own line, or its nature or net-pay-guard priority differs.
Otherwise it is an existing type with a different name, and the name belongs on the pay component.

In Malaysia these sixteen chargeable types produce only eight distinct grid rows. `BASIC_SALARY` and
`FIXED_ALLOWANCE` are identical; so are `VARIABLE_ALLOWANCE`, `COMMISSION` and `LEAVE_ENCASHMENT`; so
are the five net-only rows. They earn their places through nature, the net-pay guard and EA-form
boxes, not through the grid.

---

## 3. The four treatments

A grid cell holds one of four decisions. For a line of 288.45 typed `OVERTIME`:

| treatment       | effect                 | meaning                                                          |
| --------------- | ---------------------- | ---------------------------------------------------------------- |
| `INCLUDE`       | base += 288.45         | this is chargeable wages                                         |
| `EXCLUDE`       | base unchanged         | the Act excludes this                                            |
| `REDUCE`        | base −= 288.45         | this shrinks chargeable wages — unpaid absence, salary sacrifice |
| `SPECIAL(rule)` | routed to a named rule | chargeable, but not through the ordinary base                    |

`REDUCE` is why unpaid leave needs no second mechanism. `SPECIAL` is why no cell is ever blank: "it's
complicated" is a value, not an omission.

A fifth value, `UNSET`, exists only because the grid is materialised rather than left sparse — see §6.
It is the absence of a decision, and it cannot reach a payroll run.

---

## 4. The Malaysia grid

| component type       | EPF         | SOCSO   | EIS     | PCB         | HRDF        |
| -------------------- | ----------- | ------- | ------- | ----------- | ----------- |
| `BASIC_SALARY`       | INCLUDE     | INCLUDE | INCLUDE | INCLUDE     | INCLUDE     |
| `FIXED_ALLOWANCE`    | INCLUDE     | INCLUDE | INCLUDE | INCLUDE     | INCLUDE     |
| `VARIABLE_ALLOWANCE` | INCLUDE     | INCLUDE | INCLUDE | INCLUDE     | EXCLUDE     |
| `OVERTIME`           | **EXCLUDE** | INCLUDE | INCLUDE | INCLUDE     | **EXCLUDE** |
| `COMMISSION`         | INCLUDE     | INCLUDE | INCLUDE | INCLUDE     | EXCLUDE     |
| `BONUS`              | INCLUDE     | INCLUDE | INCLUDE | **SPECIAL** | EXCLUDE     |
| `BENEFIT_IN_KIND`    | EXCLUDE     | EXCLUDE | EXCLUDE | INCLUDE     | EXCLUDE     |
| `LEAVE_ENCASHMENT`   | INCLUDE     | INCLUDE | INCLUDE | INCLUDE     | EXCLUDE     |
| `TERMINATION_PAY`    | EXCLUDE     | EXCLUDE | EXCLUDE | INCLUDE     | EXCLUDE     |
| `UNPAID_ABSENCE`     | **REDUCE**  | REDUCE  | REDUCE  | REDUCE      | REDUCE      |
| `SALARY_SACRIFICE`   | REDUCE      | EXCLUDE | EXCLUDE | REDUCE      | EXCLUDE     |
| `STATUTORY_ORDER`    | EXCLUDE     | EXCLUDE | EXCLUDE | EXCLUDE     | EXCLUDE     |
| `LOAN_REPAYMENT`     | EXCLUDE     | EXCLUDE | EXCLUDE | EXCLUDE     | EXCLUDE     |
| `OTHER_DEDUCTION`    | EXCLUDE     | EXCLUDE | EXCLUDE | EXCLUDE     | EXCLUDE     |
| `REIMBURSEMENT`      | EXCLUDE     | EXCLUDE | EXCLUDE | EXCLUDE     | EXCLUDE     |
| `EMPLOYER_BENEFIT`   | EXCLUDE     | EXCLUDE | EXCLUDE | EXCLUDE     | EXCLUDE     |

80 cells. Each carries its authority:

| cell                              | authority                                                   |
| --------------------------------- | ----------------------------------------------------------- |
| `OVERTIME × EPF = EXCLUDE`        | EPF Act 1991 s.2 — "wages" excludes overtime                |
| `OVERTIME × HRDF = EXCLUDE`       | PSMB Act 2001 — levy on basic wages and fixed allowances    |
| `BONUS × PCB = SPECIAL`           | MTD Rules — additional remuneration                         |
| `BENEFIT_IN_KIND × PCB = INCLUDE` | ITA 1967 s.13(1)(b)                                         |
| `REIMBURSEMENT × all = EXCLUDE`   | not remuneration — a repayment of the employee's own outlay |
| `UNPAID_ABSENCE × all = REDUCE`   | wages not earned are not chargeable wages                   |

---

## 5. The lookup

What happens to one payslip line at step 5 of a run:

```
payslip_line  OT_1_5  288.45
      │  pay_components.component_type_id
      ▼
component_type  OVERTIME  (nature EARNING)
      │  for each statutory contribution in this jurisdiction, effective on the period end
      ▼
OVERTIME × EPF    EXCLUDE  ──►  EPF base    unchanged   4,500.00
OVERTIME × SOCSO  INCLUDE  ──►  SOCSO base  += 288.45   4,788.45
OVERTIME × EIS    INCLUDE  ──►  EIS base    += 288.45   4,788.45
OVERTIME × PCB    INCLUDE  ──►  PCB base    += 288.45   4,788.45
OVERTIME × HRDF   EXCLUDE  ──►  HRDF base   unchanged   4,500.00
```

Nothing in that path knows the word "Malaysia", and nothing knows the word "overtime" except the two
rows written once.

### The SPECIAL branch

A bonus of 12,000 typed `BONUS`, where `BONUS × PCB = SPECIAL(ADDITIONAL_REMUNERATION)`:

The ordinary PCB base is not touched. The amount is posted to the contribution's named side-channel —
`payslip_contributions[PCB].special_amounts.ADDITIONAL_REMUNERATION = 12,000` — and step 6 runs PCB's
additional-remuneration rule on it: annualise, tax the whole, subtract tax on the regular, withhold
the difference.

---

## 6. Completeness — how a hole and a duplicate are prevented

Two failure modes, prevented by different means. Full mechanics in chapter
[02](02-data-model.md) §7.

### A cell present twice

Structurally impossible. `contribution_treatments` carries a Postgres exclusion constraint on
(type =, contribution =, effective range &&), so a second overlapping row is rejected at `INSERT`. A
plain unique index would not do: two rows dated `[2020, 2026-07)` and `[2024, ∞)` are distinct values
but overlap, and a lookup in 2025 would find both.

The lookup therefore returns **at most one** row, by construction rather than by convention.

### A cell missing

No relational constraint can assert _for every type, a treatment exists_. So the grid is never sparse:
it is **generated**.

| inserting                | materialises                                           |
| ------------------------ | ------------------------------------------------------ |
| a component type         | one row per contribution, per jurisdiction, as `UNSET` |
| a statutory contribution | one row per component type, as `UNSET`                 |
| a jurisdiction           | the whole column, as `UNSET`                           |

A cell is therefore never absent — only undecided. Three things follow:

- the engine's lookup returns **exactly one** row, so a missing decision can never be silently read as
  `EXCLUDE` — the dangerous outcome, an under-contribution nobody notices
- the undecided set is enumerable: `WHERE treatment->>'kind' = 'UNSET'` is the work list
- activation blocks while any `UNSET` remains: _"MY has 3 undecided cells: SHARE_GAIN × EPF, SHARE_GAIN
  × SOCSO, SHARE_GAIN × EIS."_

For every `SPECIAL` treatment, the named rule must exist on that contribution, or activation blocks.

### The property this buys

Adding a component type does not create a risk of forgetting a country. It creates a visible,
countable to-do list that blocks the country until it is empty.

---

## 7. Choosing a type

The decision a customer makes when creating a pay component:

```
is money leaving the company to the employee?
├─ no ──► is it withheld from pay?
│         ├─ yes ──► court order?          ──► STATUTORY_ORDER
│         │          pre-tax?              ──► SALARY_SACRIFICE
│         │          a loan or advance?    ──► LOAN_REPAYMENT
│         │          otherwise             ──► OTHER_DEDUCTION
│         └─ no  ──► EMPLOYER_BENEFIT
│
└─ yes ─► is it repaying what the employee already spent?
          ├─ yes ──► REIMBURSEMENT
          └─ no  ──► for time beyond ordinary hours?  ──► OVERTIME
                     a value enjoyed but never paid?  ──► BENEFIT_IN_KIND
                     paid monthly regardless of activity?  ──► FIXED_ALLOWANCE
                     paid only when something happens?     ──► VARIABLE_ALLOWANCE
                     sales-linked?                         ──► COMMISSION
                     annual or performance?                ──► BONUS
                     the contractual base?                 ──► BASIC_SALARY
```

The test that matters most: _did the employee spend their own money, and is this repaying exactly
that?_ If yes, `REIMBURSEMENT`. If the amount is fixed regardless of spend, it is an allowance and it
is wages. Getting this wrong is the most common statutory error in payroll.

If nothing fits, the answer is a new component type plus a complete grid row — never a new flag on a
pay component.
