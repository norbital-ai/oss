# 13 — Extending

Every extension is rows.

---

## 1. Who does what

| product                                         | company                                 |
| ----------------------------------------------- | --------------------------------------- |
| `jurisdictions`                                 | `companies`                             |
| `statutory_contributions`, `contribution_rates` | `pay_components`                        |
| `component_types`                               | `leave_types`                           |
| `contribution_treatments` — the grid            | company `accrual_bands`                 |
| `overtime_rules`, `overtime_limits`             | `shift_definitions`, `company_holidays` |
| statutory `accrual_bands`                       |                                         |

A company picks a component type or maps an overtime rule. It never touches the grid, a rate or a
multiplier.

---

## 2. New allowance

_"We are adding a RM 200 language allowance."_

1. pick a component type — paid every month regardless of activity → `FIXED_ALLOWANCE`
2. one `pay_components` row:
   `definition { source: ENTRY, unit: MONEY, evidence: NONE, cap: null, settlement: PAYROLL }`
3. `component_entries` per person, with `origin { STANDING, effective_range }` — so they prorate

Statutory decisions made by the customer: none. The grid already says `FIXED_ALLOWANCE` is
EPF, SOCSO, EIS, PCB and HRDF liable.

---

## 3. New claim type

_"Optical claims, RM 300 a year, fully reimbursed."_

1. type `REIMBURSEMENT` — the employee spent their own money
2. one `pay_components` row:

```
definition { source: ENTRY, unit: MONEY, evidence: REQUIRED, settlement: PAYROLL,
             cap: { period: CALENDAR_YEAR, matrix: optical_band,
                    reimbursement_percentage: 100, on_exceed: BLOCK } }
```

3. cap bands — one row if flat

No base touched, net increased, cap checked at submission.

---

## 4. New leave type

_"Compassionate leave, 3 days a year, paid."_

1. one `leave_types` row: `accrual { kind: UPFRONT, carry: null }`,
   `payroll_effect { kind: PAID }`
2. one `accrual_bands` row, `owner { level: COMPANY }`, `key { by: FLAT }`, days 3
3. eligibility rules on the leave type — never a row per person

Paid leave has no payroll effect at all; only the ledger moves.

_"Study leave, unpaid."_

1. one `pay_components` row: type `UNPAID_ABSENCE`, `definition { source: FORMULA, expr … }`
2. one `leave_types` row: `payroll_effect { kind: UNPAID, component_id }`

The grid's `UNPAID_ABSENCE` row — `REDUCE` everywhere — does the rest.

---

## 5. New kind of pay thing

_"Share option exercise gain."_

Does an existing type fit? `BENEFIT_IN_KIND` — no, it is a realised gain, not a perk. `BONUS` — no,
different tax treatment. A new component type is required.

1. one `component_types` row: `SHARE_GAIN`, nature `EARNING`, sequence 650
2. **a treatment row for every contribution in every live jurisdiction:**

| jurisdiction | treatments                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| MY           | EPF EXCLUDE (not "wages" under the EPF Act) · SOCSO EXCLUDE · EIS EXCLUDE · PCB INCLUDE (ITA s.13(1)(a)) · HRDF EXCLUDE |
| SG           | CPF EXCLUDE · SDL EXCLUDE                                                                                               |
| ID           | KESEHATAN, JHT, JP, JKK, JKM EXCLUDE · PPh21 INCLUDE                                                                    |

Until all of these exist, every affected jurisdiction is blocked. This is the completeness guarantee:
a new kind of pay thing cannot be introduced without an explicit answer, for every statutory
contribution in every live country, as to whether it counts.

---

## 6. Change what a contribution counts

_"The EPF Act is amended: overtime becomes EPF-liable from 1 July 2026."_

1. end-date the existing row: `OVERTIME × EPF = EXCLUDE`, `[2020-01-01, 2026-07-01)`
2. insert its successor: `OVERTIME × EPF = INCLUDE`, `[2026-07-01, ∞)`, authority _EPF (Amendment)
   Act 2026 s.4_

One row edited. Every customer, every overtime component, every company in Malaysia — all correct from
July, all unchanged before. June payslips replay against the old row via `configuration_hash`.

---

## 7. Statutory rate change

_"The SOCSO ceiling rises from 6,000 to 8,000 on 1 October."_

1. end-date the terminal band
2. insert the new bands from 6,000 to 8,000
3. insert the new terminal band at 8,000

No formula changes, because no formula ever wrote `min(base, 6000)`.

---

## 8. New country

| #   | rows                                                                                               |
| --- | -------------------------------------------------------------------------------------------------- |
| 1   | one `jurisdictions` row — currency, tax year, proration, rounding, ordinary rate basis and divisor |
| 2   | one `statutory_contributions` row per scheme — payer, keyed_by, sequence, relief_for               |
| 3   | `contribution_rates` — one per band per scheme                                                     |
| 4   | `contribution_treatments` — 16 rows per contribution, the whole grid column                        |
| 5   | `overtime_rules` — one per day type and hour band; `overtime_limits`                               |
| 6   | statutory `accrual_bands` — the leave minima                                                       |

No code, no new tables, no per-country schema, and no new component types unless the country genuinely
has a kind of pay thing that nowhere else has.

---

## 9. Anti-patterns

| tempting                                                          | instead                                                                           |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| add an `epf_exempt` flag to a pay component                       | pick the right component type, or create one with a full grid row                 |
| write `min(base, 6000)` in a formula                              | make it the terminal rate band                                                    |
| write `× 1.5` in an overtime formula                              | an `overtime_rules` row at jurisdiction level; the company maps a component to it |
| divide by 26 in a formula                                         | `jurisdictions.ordinary_rate_divisor`                                             |
| hardcode the 9,000 relief in PCB                                  | a row in the reliefs table                                                        |
| a `CORRECTION` component type                                     | arrears take the type of the thing they correct                                   |
| a "days remaining" column                                         | `SUM(leave_ledger)` plus derivation                                               |
| a "claimed to date" column                                        | `SUM(component_entries)`                                                          |
| `ot_eligible ? amount : 0` in a formula                           | `pay_components.eligibility` — an ineligible component produces no line at all    |
| a negative amount on an entry                                     | magnitudes plus nature plus treatment; reversals use `origin: REVERSAL`           |
| a year-to-date table                                              | `SUM` over `payslip_contributions`                                                |
| a nullable column used only when another column has a given value | a discriminated union — chapter [01](01-conventions.md) §3                        |
| a nightly job to refresh balances                                 | derive them; nothing in this system runs on a schedule                            |
