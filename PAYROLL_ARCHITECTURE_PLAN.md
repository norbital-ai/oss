# Payroll architecture

## The idea

A payslip is a list of lines. A few totals matter. The only hard question in payroll is _which lines
count toward which total_, and that is a matter of law.

Ahmad, January:

| line                  | amount   |
| --------------------- | -------- |
| Basic salary          | 4,000.00 |
| On-call allowance     | 200.00   |
| Shift allowance       | 150.00   |
| Transport allowance   | 150.00   |
| Overtime              | 288.45   |
| Medical reimbursement | 93.50    |

| total      | value    | why                                            |
| ---------- | -------- | ---------------------------------------------- |
| Gross      | 4,788.45 | every earning                                  |
| EPF base   | 4,500.00 | overtime is out — the EPF Act excludes it      |
| SOCSO base | 4,788.45 | overtime is in                                 |
| HRDF base  | 4,500.00 | the levy is on basic and fixed allowances only |

Overtime is in the SOCSO base and out of the EPF base because two Acts say so. That fact is written
once, in the Malaysian ruleset, rather than repeated on every allowance a customer creates.

```
a pay component        has a       component type      which the law maps to
"Transport Allowance"    ───►      FIXED_ALLOWANCE       ──►  EPF ✓ SOCSO ✓ EIS ✓ PCB ✓ HRDF ✓
"Overtime"               ───►      OVERTIME              ──►  EPF ✗ SOCSO ✓ EIS ✓ PCB ✓ HRDF ✗
"Medical Claim"          ───►      REIMBURSEMENT         ──►  EPF ✗ SOCSO ✗ EIS ✗ PCB ✗ HRDF ✗
```

`component_types` is a closed list. `contribution_treatments` is the grid mapping every type to every
statutory contribution. Every cell must be filled. A new type blocks the country until "does EPF count
this?" is answered for every contribution.

## Rules

| #   | rule                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------- |
| R1  | The law is stated once, per country. A company picks a type or maps a rule; it never states a rate, a multiplier or a treatment. |
| R2  | Declare a fact at the highest level at which it is true.                                                                         |
| R3  | `resolved = max(statutory, company) + Σ individual`, for leave days and claim caps alike.                                        |
| R4  | Amounts are magnitudes. Direction comes from the component type's nature and from the treatment.                                 |
| R5  | Derive what can be derived; store only events.                                                                                   |
| R6  | A settled fact is never updated. Every correction is an approval-stamped append.                                                 |
| R7  | Nothing runs on a schedule. Every value is written by a person or computed when read.                                            |
| R8  | A field must be meaningful for every row of its table. Otherwise it belongs in a variant.                                        |

## Chapters

| #   | chapter                                                   | covers                                                                    |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| 01  | [Conventions](plan/01-conventions.md)                     | levels, approval, variants — read first                                   |
| 02  | [Data model](plan/02-data-model.md)                       | every model, field and relation                                           |
| 03  | [Component types and the grid](plan/03-types-and-grid.md) | the closed type list; which pay is chargeable under which law             |
| 04  | [Statutory contributions](plan/04-contributions.md)       | base to employee and employer amounts                                     |
| 05  | [The payroll run](plan/05-payroll-run.md)                 | eight steps, periods, proration, formulas, settlement                     |
| 06  | [Time and overtime](plan/06-time-and-overtime.md)         | clocks to hours to money; day types; statutory multipliers                |
| 07  | [Leave](plan/07-leave.md)                                 | eligibility, entitlement, the ledger, derived accrual                     |
| 08  | [Claims and caps](plan/08-claims.md)                      | reimbursements, layered caps, settlement routes                           |
| 09  | [Repayment agreements](plan/09-agreements.md)             | loans, advances, overpayment recovery                                     |
| 10  | [Payslip and reporting](plan/10-payslip.md)               | outputs, year-to-date, filings, payment                                   |
| 11  | [Corrections](plan/11-corrections.md)                     | reversals, arrears, derived history                                       |
| 12  | [Validation](plan/12-validation.md)                       | what blocks activation, a run, or approval                                |
| 13  | [Extending](plan/13-extending.md)                         | new allowance, leave type, contribution, country                          |
| 14  | [Examples](plan/14-examples.md)                           | Malaysia in full; hard cases; Singapore and Indonesia; things going wrong |

## Vocabulary

| word                   | means                                          |
| ---------------------- | ---------------------------------------------- |
| pay component          | a type of line — "Transport Allowance"         |
| component entry        | one occurrence for one person — Ahmad's RM 150 |
| component type         | what kind of line it is — `FIXED_ALLOWANCE`    |
| statutory contribution | a scheme the government runs — EPF, CPF, SSS   |
| treatment              | whether a type counts toward a contribution    |
| base                   | the total a contribution is calculated on      |
| jurisdiction           | a country's ruleset                            |
| accrual band           | leave days by length of service                |
| leave ledger           | the record of leave days in and out            |
| payslip line           | one computed line of output                    |
| payroll run            | one execution over a company and a period      |
| effective range        | the dates a configuration row is valid for     |

## Industry names

| here                            | Oracle                         | SAP                                |
| ------------------------------- | ------------------------------ | ---------------------------------- |
| `pay_components`                | element                        | wage type                          |
| `component_entries`             | element entry                  | wage type entry (IT0014 / IT0015)  |
| `component_types`               | element classification         | wage type group                    |
| `contribution_treatments`       | balance feed by classification | cumulation class matrix (V_512W_D) |
| `payslip_contributions`         | balance                        | cumulation wage type               |
| `payslip_lines`                 | run result                     | payroll result table RT            |
| `leave_types` + `accrual_bands` | absence plan + accrual matrix  | absence quota + quota generation   |

Oracle and SAP materialise leave accrual through a scheduled process. This design derives it
(chapter [07](plan/07-leave.md) §7), so nothing must have run for a balance to be correct. The
derivation holds for closed-form plans — days per year by length of service. It does not hold for
accrual per hours worked or for waiting periods; neither is supported.
