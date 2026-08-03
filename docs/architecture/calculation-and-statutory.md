# Calculation and statutory treatment

## Contractual wages and proration

Base salary comes from every effective term segment intersecting the covered period. Each segment is
prorated against the same full-period denominator and then summed, so a mid-month salary change does
not lose or duplicate a day.

Malaysia incomplete-month and ordinary unpaid-leave calculations use the configured statutory
calendar-day basis where applicable:

```text
calendar-day rate = round(monthly salary / calendar days in month, 2)
dated deduction   = round(calendar-day rate × unpaid days, 2)
```

Other jurisdictions or pay frequencies may select working-day or fixed-day proration through
configuration. The formula is not copied into company pay components.

## Component measurement

| Definition source | Measurement                                                                 | Typical inputs                                        |
| ----------------- | --------------------------------------------------------------------------- | ----------------------------------------------------- |
| `SCHEDULE`        | Contract amount × period fraction                                           | Effective terms, employment range, roster divisor     |
| `ENTRY`           | Sum of approved dated entries, with per-entry proration/cap when configured | Claims, allowances, recoveries, corrections           |
| `FORMULA`         | Closed expression over measured components, terms, leave and period facts   | Ordinary rate information, NPL and derived allowances |
| `OVERTIME`        | Dated statutory award after schedule/day classification                     | Time entry, shift, roster, holiday, OT rule           |
| `OVERTIME_EXCESS` | Statutory value reclassified beyond daily/monthly control                   | Same time entry and rule as the original OT           |

Amounts are stored as magnitudes. Earning/deduction direction comes from the pay component policy and
contribution treatment. A correction never sneaks direction in through a negative amount.

### Claimable components

An `ENTRY` component declares three things beyond its unit, because a claim is a different kind of
object from an allowance:

- `evidence` — `NONE`, `OPTIONAL` or `REQUIRED`, deciding whether a receipt must accompany the amount.
- `cap` — a period (`CALENDAR_YEAR`, `LEAVE_YEAR`, `MONTH`, `LIFETIME` or `PER_EVENT`), the matrix the
  limit is read from, a reimbursement percentage, and `on_exceed` of `BLOCK` or `ALLOW`.
- `settlement` — `PAYROLL` when the money rides the payslip, `COMPANY_DIRECT` when the company pays
  the provider and payroll records only that it happened.

`on_exceed` is configurable rather than always blocking because some benefit limits are hard and
some are soft ones a manager may deliberately exceed. A system that can only refuse pushes the soft
case out into a spreadsheet, where it stops being visible to payroll at all.

The pay-component definition carries no statutory information. Whether a component is EPF wages is
owned by the strict policy union on its `component_type`; renaming a component cannot change its
settlement direction or what it is chargeable to.

### Leave entitlement

Entitlement for one leave code collapses three layers to `max(statutory, company ?? statutory)`. The
statutory figure is a floor, not a default: a company that mis-configures maternity leave as 60 days
still owes 98. Compliance does not depend on the customer configuring correctly, which is the only
arrangement that survives contact with a real tenant.

## Component-owned contribution treatment grid

Every pay component policy carries one effective treatment for every statutory contribution:

| Treatment | Effect on contribution base                                    |
| --------- | -------------------------------------------------------------- |
| `INCLUDE` | Add the line                                                   |
| `EXCLUDE` | Ignore the line                                                |
| `REDUCE`  | Subtract an absence/recovery amount when the law requires it   |
| `SPECIAL` | Apply a named contribution-specific rule                       |
| `UNSET`   | Configuration is incomplete; activation/calculation is blocked |

This cross-product makes omissions visible. Adding a new pay component cannot silently bypass EPF,
SOCSO, EIS, tax or another scheme.

## Malaysian treatment summary

The effective tables remain the authority; this summary describes the intended classification:

- Genuine overtime and the same value reclassified as statutory-excess incentive OT are excluded
  from EPF wages.
- Salary, ordinary incentives, allowances, bonuses and arrears follow their configured legal
  treatment.
- SOCSO and EIS use the insured wage base, including applicable salary, overtime, incentives and
  allowances, then apply the effective ceiling/table.
- PCB consumes taxable remuneration, relief facts, periods remaining and earlier paid YTD.
- HRD levy applies the effective employer rate to the configured eligible wage base.

Source incentive-overtime columns can represent a business incentive rather than statutory excess.
Because the system cannot prove that meaning from the output column alone, it is not seeded. A
variance remains until the underlying policy or event is supplied.

## Contribution calculation

For each statutory scheme the engine persists:

```text
base_amount
employee_amount
employer_amount
band_reference
special_amounts
```

Persisting the base makes the calculation auditable. A manual amount-only override is not an
acceptable reconciliation fix because the same wrong base can affect later bands, tax and YTD.

## YTD

YTD is not a mutable ledger table. It is the sum of earlier paid results in the current tax year:

```text
YTD contribution base/share
  = SUM(payslip_lines WHERE component.kind starts with 'STATUTORY_')
    over earlier PAID runs for the employee and statutory scheme
```

Only `PAID` periods contribute. The previous-period-paid gate prevents a later draft from building
against moving YTD. Current reconciliation separately checks that source and generated workbooks
contain no duplicate employee-month rows before summing YTD.

## Validation levels

1. Configuration validation blocks undecided treatments, missing rule mappings, bad formulas and
   ineffective/gapped tables.
2. Run validation blocks open clocks, missing terms, unusable calendars and truncated reads.
3. Result validation checks settlement identities, source expectations and non-negative net.
4. Warnings expose schedule/compliance breaches such as total work above 12 hours or ordinary OT
   above 104 hours; the earned value is still paid/reclassified.

## Official Malaysian references

- [Employment Act 1955 (current JTKSM download page)](https://jtksm.mohr.gov.my/en/borang/employment-act-1955)
- [Employment (Limitation of Overtime Work) Regulations 1980](https://jtksm.mohr.gov.my/sites/default/files/2023-03/7.%20EMPLOYMENT%20%28LIMITATION%20OF%20OVERTIME%20WORK%29%20REGULATIONS%201980_0.pdf)
- [JTKSM Employment Act 2022 amendment FAQ](https://jtksm.mohr.gov.my/ms/soalan-lazim/akta-kerja-1955-pindaan-2022)
- [EPF employer contribution guidance](https://www.kwsp.gov.my/en/employer/responsibilities/mandatory-contribution)
- [PERKESO contribution rates](https://www.perkeso.gov.my/en/rate-of-contribution.html)
- [LHDN PCB specifications](https://www.hasil.gov.my/majikan/potongan-cukai-bulanan-pcb/)
