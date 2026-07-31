# 04 — Statutory contributions

This is a canonical chapter of the payroll architecture.

A contribution turns a base into an employee amount and an employer amount. It never knows what
produced the base. Chapter [03](03-types-and-grid.md) built the base; this chapter spends it.

---

## 1. The mechanism

```
payslip_contributions[EPF].base_amount = 4,500.00      built by the grid
      │
      ▼
1  SELECT BAND         by contribution_rates.selector
                         WAGE          band_from ≤ base < band_to
                         WAGE_AND_AGE  also match age_from/age_to against derived age
                         HEADCOUNT     match derived headcount
                         RISK_CLASS    match companies.risk_class
      ▼
2  APPLY AWARD         PERCENT      employee = base × employee rate
                       FIXED        employee = the tabled amount
                       PROGRESSIVE  see §5
      ▼
3  ROUND               contribution.rounding, never a formula
      ▼
4  GATE                employment_statutory_facts.status
                         NOT_REGISTERED   ──► employee 0, employer 0
                         REGISTERED with rate_override ──► use it
      ▼
payslip_contributions[EPF]  base 4,500.00 · employee 495.00 · employer 585.00
```

---

## 2. Ordering and reliefs

Some contributions are relievable against another's tax computation. EPF employee contributions
reduce chargeable income, so PCB must run after EPF.

| seq | contribution | payer    | `relief_for` |
| --- | ------------ | -------- | ------------ |
| 10  | EPF          | both     | PCB          |
| 20  | SOCSO        | both     | PCB          |
| 30  | EIS          | both     | PCB          |
| 40  | PCB          | employee | —            |
| 50  | HRDF         | employer | —            |

```
grid builds:   EPF base 4,500.00 · SOCSO base 4,788.45 · PCB base 4,788.45

seq 10  EPF    ee 495.00  ──► PCB relief pool += 495.00   (capped 4,000/yr)
seq 20  SOCSO  ee  23.25  ──► PCB relief pool +=  23.25   (capped   350/yr)
seq 30  EIS    ee   9.30  ──► PCB relief pool +=   9.30   (same 350 cap)
seq 40  PCB    reads the PCB base minus the relief pool
seq 50  HRDF   reads the HRDF base, employer only
```

`relief_for` says _this scheme's employee share is a relief inside that scheme's computation_. It
never reduces a base. Validation rejects a cycle, and rejects a contribution that is a relief for one
with a lower sequence.

---

## 3. Floors and ceilings are bands

Wrong: `min(base, 6000) × rate` in a formula. The 6,000 lives in an expression, and it was 5,000
before October 2024.

Right: the terminal `contribution_rates` band.

| band_from | band_to  | employee | employer |
| --------- | -------- | -------- | -------- |
| 0.00      | 30.00    | 0.10     | 0.40     |
| …         |          |          |          |
| 5,900.00  | 6,000.00 | 29.75    | 104.15   |
| 6,000.00  | _null_   | 29.75    | 104.15   |

Raising the ceiling means end-dating the last two rows and inserting successors. No formula changes.

There is no `wage_floor` or `wage_ceiling` column: a floor is the first band, a ceiling is the
terminal band.

---

## 4. Malaysia

### EPF

Bracket table, keyed by wage and age. EPF Act 1991, Third Schedule. Each share rounded up to the next
ringgit independently.

| wage           | increments |
| -------------- | ---------- |
| ≤ 5,000        | RM 20      |
| 5,000 – 20,000 | RM 100     |
| > 20,000       | exact      |

| age  | wage    | employee | employer |
| ---- | ------- | -------- | -------- |
| < 60 | ≤ 5,000 | 11%      | 13%      |
| < 60 | > 5,000 | 11%      | 12%      |
| ≥ 60 | any     | 0%       | 4%       |

Ahmad, base 4,500, age 33: band 4,480.01–4,500.00 → employee ⌈4,500 × 0.11⌉ = 495, employer
⌈4,500 × 0.13⌉ = 585.

Age comes from `employees.date_of_birth` against the period end. No formula knows what 60 means; it is
`age_from` on a rate row.

### SOCSO

Bracket table, keyed by wage and age. Employees' Social Security Act 1969. Amounts are tabled, not
computed.

| age  | category                | employee       | employer        |
| ---- | ----------------------- | -------------- | --------------- |
| < 60 | 1 — injury + invalidity | 0.5% as tabled | 1.75% as tabled |
| ≥ 60 | 2 — injury only         | 0%             | 1.25% as tabled |

Ahmad, base 4,788.45 → band 4,700.01–4,800.00 → employee 23.25, employer 81.35.

### EIS

Bracket table. Employment Insurance System Act 2017. Not liable from age 60.

Ahmad, base 4,788.45 → employee 9.30, employer 9.30.

### HRDF

Rate, keyed by headcount. PSMB Act 2001. Employer only.

| headcount | rate                       |
| --------- | -------------------------- |
| ≥ 10      | 1.0% mandatory             |
| 5 – 9     | 0.5% optional registration |
| < 5       | not liable                 |

Headcount is derived from active employments at the period end. The base excludes overtime and
variable allowances — that is the grid's job, not this contribution's.

Nihon, base 4,500 × 1% = 45.00.

---

## 5. PCB

The only contribution with real machinery.

| input                                    | value    |
| ---------------------------------------- | -------- |
| P — this period's PCB base               | 4,788.45 |
| Y — PCB base year-to-date                | 0.00     |
| n — periods remaining, this one included | 12       |
| A — additional remuneration this period  | 0.00     |

```
1  PROJECT      annual = Y + P × n = 57,461.40

2  RELIEVE      individual                          9,000.00
               EPF employee, capped                 4,000.00
               SOCSO + EIS employee, capped           350.00
               spouse / child / disability      from employment_statutory_facts
               chargeable = 57,461.40 − 13,350.00 = 44,111.40

3  SCALE        contribution_rates, PROGRESSIVE awards
                 band          rate   constant
                 0 – 5,000       0%          0
                 5,000 – 20,000  1%       −400
                 20,000 – 35,000 3%       −250
                 35,000 – 50,000 6%       +600
                 50,000 – 70,000 11%    +1,500
               tax = rate × chargeable + constant = 1,165.73

4  SPREAD       monthly = (tax − withheld year-to-date) / n = 97.14
               round per contribution.rounding (UP_5_CENTS) → 97.15

5  ADDITIONAL   only when A > 0
               extra = scale(chargeable + A) − scale(chargeable)
               PCB this period = monthly + extra
```

Every number above — 9,000, 4,000, 350, the scale, the rounding — is a row, not an expression.

---

## 6. What a new country needs

| step | rows                                                 |
| ---- | ---------------------------------------------------- |
| 1    | one `jurisdictions` row                              |
| 2    | one `statutory_contributions` row per scheme         |
| 3    | `contribution_rates` — one per band per scheme       |
| 4    | `contribution_treatments` — 16 rows per contribution |
| 5    | `overtime_rules` and `overtime_limits`               |
| 6    | statutory `accrual_bands`                            |

No code, no new tables, no per-country schema.
