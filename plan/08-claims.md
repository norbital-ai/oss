# 08 — Claims and caps

A claim is a reimbursement: the employee spent their own money and the company pays it back. It is not
wages, so it enters no contribution base. The interesting part is the cap.

---

## 1. The shape

A claim has no state of its own. It is a `component_entries` row with `origin.kind = CLAIM`, written
immediately and locked until approved.

```
employee submits
      │
      ├─ CAP CHECK happens here, before the write
      │     admissible = min(claimed × pct, cap − consumed)
      ▼
component_entries row INSERTED
  norbital_approval_id set ──► pending, immutable, invisible to payroll
      │
      ├── approved ──► the stamp clears
      └── rejected ──► rolled back from typed temporal history; the row does not exist

then, by definition.settlement:
  PAYROLL         pay_period set   ──► picked up by the next run
  COMPANY_DIRECT  pay_period null  ──► never reaches payroll
```

The cap is checked at **submission**, not at run time. By payroll day the money is already committed.

---

## 2. The cap

Three layers, resolved by R3 — the same rule as leave entitlement.

| layer      | source                                                                  | Ahmad, 66 months |
| ---------- | ----------------------------------------------------------------------- | ---------------- |
| statutory  | a legal minimum benefit where one exists; Malaysia has none for medical | —                |
| company    | `definition.cap`, banded by a derived factor                            | 1,500.00         |
| individual | entries on a cap-extension component                                    | +500.00          |

```
cap = max( statutory minimum, company band(derived.service_months) )
    + Σ individual extension entries
    = max(0, 1,500.00) + 500.00
    = 2,000.00
```

The statutory layer is a floor; the individual layer adds. There is no `individual_mode` — one
composition rule in the whole system.

Company cap bands:

| service months from | amount   |
| ------------------- | -------- |
| 0                   | 500.00   |
| 24                  | 1,000.00 |
| 60                  | 1,500.00 |

---

## 3. Cap periods and consumption

| period              | resets                                         |
| ------------------- | ---------------------------------------------- |
| `CALENDAR_YEAR`     | 1 January                                      |
| `PLAN_YEAR`         | on the company's benefit year                  |
| `ROLLING_12_MONTHS` | a moving window ending today                   |
| `MONTHLY`           | each month                                     |
| `PER_EVENT`         | a limit on a single claim, not a running total |

```
consumed(employment, component, period)
  = SELECT SUM(amount) FROM component_entries
     WHERE employment_id    = ?
       AND pay_component_id = ?
       AND event_date IN period
       AND origin.kind <> 'REVERSAL'
       AND NOT EXISTS (a REVERSAL origin naming this row)
     [ AND norbital_approval_id IS NULL ]

available = cap − consumed
```

There is no "claimed to date" column and no scheduled job. A cap is a ceiling resolved from bands
whenever asked, and consumption is a `SUM` over the entries. Nothing accrues, so nothing needs
materialising — the opposite of leave.

### Which predicate

| caller                     | approval predicate        | why                                       |
| -------------------------- | ------------------------- | ----------------------------------------- |
| a cap check on a new claim | omitted — pending counted | a submitted claim has reserved its budget |
| payroll and reporting      | included — settled only   | never act on an unapproved row            |

Cap 2,000, settled 745.50, one claim of 900.00 pending, a new claim of 800.00:

- against settled: `1,254.50 ≥ 800` → allowed; both approve → 2,445.50 spent against a 2,000 cap
- against projected: `354.50 < 800` → refused

---

## 4. The submission check

```
claim MEDICAL RM 420.00, incurred 2026-06-14

1  cap           = 2,000.00      three layers, §2
2  consumed      =   745.50      calendar year 2026, pending included
3  available     = 1,254.50
4  reimbursable  = 420.00 × reimbursement_percentage 100%  = 420.00
5  admissible    = min(420.00, 1,254.50)                   = 420.00   ✓
```

Over the cap, by `cap.on_exceed`:

| value   | effect                                                          |
| ------- | --------------------------------------------------------------- |
| `BLOCK` | rejected at submission, with the numbers shown                  |
| `CLIP`  | approved at the available amount; the balance is the employee's |
| `ALLOW` | approved in full, flagged as over-cap for reporting             |

`reimbursement_percentage` handles co-pay: a dental plan at 80% turns a RM 500 receipt into a RM 400
claim, and it is the RM 400 that consumes the cap.

---

## 5. Settlement routes

| route            | `pay_period` | effect                                                                                                                          |
| ---------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `PAYROLL`        | set          | a payslip line, type `REIMBURSEMENT`, nature `NON_WAGE_PAYMENT` — net increases, no base moves                                  |
| `COMPANY_DIRECT` | null         | the company paid the clinic; the employee never saw the money. Consumes the cap, appears in benefit reporting, never in payroll |

A null `pay_period` is how the payroll query excludes `COMPANY_DIRECT` entries without a special case.

---

## 6. On the payslip

| line          | amount | type            | EPF     | SOCSO   | EIS     | PCB     | HRDF    |
| ------------- | ------ | --------------- | ------- | ------- | ------- | ------- | ------- |
| Medical claim | 93.50  | `REIMBURSEMENT` | EXCLUDE | EXCLUDE | EXCLUDE | EXCLUDE | EXCLUDE |

Gross unchanged, every base unchanged, net + 93.50.

Two payments of RM 150 in the same month, differing only in their component's type:

| component | type              | effect                                     |
| --------- | ----------------- | ------------------------------------------ |
| TRANSPORT | `FIXED_ALLOWANCE` | gross +150, EPF +150, SOCSO +150, net +150 |
| MEDICAL   | `REIMBURSEMENT`   | gross 0, EPF 0, SOCSO 0, net +150          |

Neither component names a contribution. The difference is entirely what the law says about those two
types.

---

## 7. Claims, expenses and allowances

The same object with a different type:

| thing                          | component type       | why                                                        |
| ------------------------------ | -------------------- | ---------------------------------------------------------- |
| medical claim                  | `REIMBURSEMENT`      | the employee's own outlay, repaid                          |
| dental claim                   | `REIMBURSEMENT`      | same                                                       |
| travel expense                 | `REIMBURSEMENT`      | same                                                       |
| mileage                        | `REIMBURSEMENT`      | same, quantity × rate                                      |
| meal allowance, fixed per day  | `VARIABLE_ALLOWANCE` | paid whether or not anything was spent — it is wages       |
| phone bill paid by the company | `BENEFIT_IN_KIND`    | the company pays the vendor; the employee enjoys the value |

The test: did the employee spend their own money, and is this repaying exactly that? If yes,
`REIMBURSEMENT`. If the amount is fixed regardless of spend, it is an allowance and it is wages.

---

## 8. Reporting

Utilisation per employment, per component, per cap period — all three figures derived:

```
cap        2,000.00   from the three layers
consumed   1,165.50   SUM over component_entries
available    834.50   subtraction
```

Nothing stored.
