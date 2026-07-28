# 10 — Payslip and reporting

Everything downstream of a run reads three tables. There is no separate reporting model and no
year-to-date store.

---

## 1. The output shape

```
payroll_runs   company · period 2026-01 · lifecycle PAID · configuration_hash
                       · attendance 22 Dec – 21 Jan · pay date 25 Jan
      │
      ▼
payslips       Ahmad   gross 4,788.45 · deductions 791.70 · net 4,090.25
                       · employer cost 720.65
      │
      ├──► payslip_lines            one per pay component that produced an amount
      └──► payslip_contributions    one per statutory contribution
```

| table                   | answers                                     |
| ----------------------- | ------------------------------------------- |
| `payslip_lines`         | what did we pay, line by line               |
| `payslip_contributions` | what did each scheme take, and on what base |
| `payslips`              | the four numbers that matter                |

`component_type_id` is copied onto each line, so a payslip renders and a report groups without
re-resolving configuration that may have changed since.

---

## 2. Rendering

Grouped by `component_types.nature`, ordered by `component_types.sequence`. There is no layout
metadata in the model.

```
EARNINGS
  Basic salary                                        4,000.00
  On-call allowance                                     200.00
  Shift allowance                                       150.00
  Transport allowance                                   150.00
  Overtime               10.0 h × 1.5 × 19.23           288.45
                                                   ───────────
  Gross pay                                           4,788.45

DEDUCTIONS
  EPF                          on 4,500.00             (495.00)
  SOCSO                        on 4,788.45              (23.25)
  EIS                          on 4,788.45               (9.30)
  PCB                          on 4,788.45              (97.15)
  Staff loan repayment                3/12             (167.00)

PAYMENTS
  Medical claim                     #4471                93.50
                                                   ───────────
  NET PAY                                             4,090.25

EMPLOYER   EPF 585.00 · SOCSO 81.35 · EIS 9.30 · HRDF 45.00      720.65
```

Parentheses come from `nature = DEDUCTION`, not from a stored sign. Section order comes from
`sequence`. Nothing else decides layout.

---

## 3. Year-to-date

There is no year-to-date table, column or accumulator.

```
ytd_contribution(employment, contribution, year)
  = SELECT SUM(base_amount), SUM(employee_amount), SUM(employer_amount)
      FROM payslip_contributions c
      JOIN payslips p       ON p.id = c.payslip_id
      JOIN payroll_runs r   ON r.id = p.payroll_run_id
     WHERE p.employment_id = ?
       AND c.statutory_contribution_id = ?
       AND r.period BETWEEN year_start AND year_end
       AND r.lifecycle = 'PAID'
```

`ytd_component` is the same shape over `payslip_lines`. The tax year boundary is
`jurisdictions.tax_year_start_month`, so an April tax year needs no code.

PCB needs year-to-date base and tax withheld; the EA form needs year-to-date gross and EPF; EPF
Form A needs one period. All three are this query.

---

## 4. Statutory filings

Each filing is a projection; none needs a new model.

| filing              | reads                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| EPF Form A, monthly | `payslip_contributions` where contribution = EPF, plus the reference number from `employment_statutory_facts` |
| SOCSO Borang 8A     | same shape, contribution = SOCSO                                                                              |
| EIS Lampiran 1      | same shape, contribution = EIS                                                                                |
| CP39 (PCB)          | same shape, contribution = PCB                                                                                |
| HRDF levy return    | `SUM(employer_amount)` where contribution = HRDF, per company                                                 |
| EA Form, annual     | year-to-date `payslip_lines` grouped by component type, plus year-to-date EPF and PCB                         |
| CP8D, annual        | the EA form per company, in a filing layout                                                                   |

A missing reference number blocks the filing, not the run.

EA form boxes map to component types, which is why the type list is at that granularity:

| box                 | source                                                                                |
| ------------------- | ------------------------------------------------------------------------------------- |
| B1(a) gross salary  | Σ lines of type `BASIC_SALARY`, `FIXED_ALLOWANCE`, `VARIABLE_ALLOWANCE`, `COMMISSION` |
| B1(b) bonus         | Σ lines of type `BONUS`                                                               |
| B1(c) overtime      | Σ lines of type `OVERTIME`                                                            |
| B2 benefits in kind | Σ lines of type `BENEFIT_IN_KIND`                                                     |
| C termination       | Σ lines of type `TERMINATION_PAY`                                                     |
| F EPF employee      | Σ `payslip_contributions[EPF].employee_amount`                                        |
| G PCB deducted      | Σ `payslip_contributions[PCB].employee_amount`                                        |

---

## 5. Payment

Approved payslips plus employment bank details produce a payment instruction: beneficiary, account,
bank code, amount, reference. Formats are DuitNow, IBG or bank-specific fixed-width. It is generated
from payslips, never stored as a separate ledger.

Statutory payment files — EPF, SOCSO, EIS employee and employer shares, PCB to LHDN — all read
`payslip_contributions`: one query shape, five files.

---

## 6. Provenance

_Why is this line 288.45?_

```
payslip_line  OT_1_5  288.45  quantity 10.0  rate 19.23
   ├─ pay_component OT_1_5  ──► definition { source: OVERTIME, rule … }
   ├─ source_entry_id       ──► null; the source is time_entries in the window
   └─ payroll_run.configuration_hash ──► the exact rules and rates used
```

_Why is the EPF base 4,500 and not 4,788.45?_ Replay step 5 over `payslip_lines`:

| line              | type                              | treatment   | contribution |
| ----------------- | --------------------------------- | ----------- | ------------ |
| BASIC, allowances | `BASIC_SALARY`, `FIXED_ALLOWANCE` | INCLUDE     | +4,500.00    |
| OT_1_5            | `OVERTIME`                        | **EXCLUDE** | ·            |
| MEDICAL           | `REIMBURSEMENT`                   | EXCLUDE     | ·            |
| LOAN_REPAY        | `LOAN_REPAYMENT`                  | EXCLUDE     | ·            |

The treatment row carries its authority: _EPF Act 1991 s.2 — "wages" excludes overtime._

Every number on a payslip traces to a row, and every treatment traces to a section of an Act.

---

## 7. Management reporting

| report                               | query                                                             |
| ------------------------------------ | ----------------------------------------------------------------- |
| payroll cost by month and department | `Σ payslips.gross + Σ payslips.employer_cost`                     |
| statutory exposure                   | `Σ payslip_contributions.employer_amount` grouped by contribution |
| overtime intensity                   | `Σ payslip_lines.quantity` where type = `OVERTIME`, ÷ headcount   |
| leave liability                      | Σ ledger balance × daily rate, grouped by leave type              |

Leave liability is an accrued cost rather than a payroll figure: 1,043.5 days outstanding across 127
staff at an average daily 153.85 is RM 160,542.48.
