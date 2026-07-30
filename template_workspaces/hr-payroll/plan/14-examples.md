# 14 — Examples

Four parts: one Malaysian payslip in full, the cases that usually need special code, the same engine
in Singapore and Indonesia, and things going wrong.

All rates are seeded data. Figures illustrate the seeded tables; the authoritative values are whatever
`contribution_rates` holds on the run date.

---

# Part 1 — One payslip in full

**Nihon Pigment (M) Sdn Bhd** · Malaysia · 132 staff · cutoff 21st · paid 25th · HRDF 1%.

```
Ahmad Razak · NP-0142
hire 2020-07-01 → service 66 months · born 1992-03-14 → age 33
basic RM 4,000 · 48 h / 6 days · NON_MANUAL · overtime eligible
registered: EPF · SOCSO · EIS · PCB
```

### Step 1 — pick

Period 2026-01, attendance window 22 Dec – 21 Jan, 31 calendar days, 31 employed. Configuration hash
covers the Malaysian ruleset at 31 January, 80 treatments, 5 contributions and their rates, 6 overtime
rules, and Nihon's components.

### Step 2 — validate

80 treatments present · 1 `SPECIAL` cell names a rule that exists · 6 overtime rules mapped to 6
components · every component type resolves · every formula token resolves · EPF, SOCSO and EIS precede
PCB in sequence.

### Step 3 — gather

| plane               | rows                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `component_entries` | ONCALL 200 standing · SUA 150 standing · TRANSPORT 150 standing · MEDICAL 93.50 (claim #4471) · LOAN_REPAY 167.00 (agreement #12, seq 3 of 12) |
| `leave_ledger`      | none in the window                                                                                                                             |
| `time_entries`      | 5 days with overtime, 10.0 h beyond normal                                                                                                     |

### Step 4 — measure

| seq  | component   | type            | amount   | how                |
| ---- | ----------- | --------------- | -------- | ------------------ |
| 10   | HOURLY_RATE | INFORMATION     | 19.23    | 4,000 / 26 / 8     |
| 100  | BASIC       | BASIC_SALARY    | 4,000.00 | 31/31 employed     |
| 200  | ONCALL      | FIXED_ALLOWANCE | 200.00   | entry              |
| 200  | SUA         | FIXED_ALLOWANCE | 150.00   | entry              |
| 200  | TRANSPORT   | FIXED_ALLOWANCE | 150.00   | entry              |
| 400  | OT_1_5      | OVERTIME        | 288.45   | 10.0 × 1.5 × 19.23 |
| 1300 | LOAN_REPAY  | LOAN_REPAYMENT  | 167.00   | schedule           |
| 1500 | MEDICAL     | REIMBURSEMENT   | 93.50    | entry              |

The 26 comes from `jurisdictions.ordinary_rate_divisor`; the 1.5 from `overtime_rules`. Neither is
written by Nihon.

### Step 5 — accumulate

| line              | type            | EPF          | SOCSO        | EIS          | PCB          | HRDF         |
| ----------------- | --------------- | ------------ | ------------ | ------------ | ------------ | ------------ |
| BASIC 4,000.00    | BASIC_SALARY    | +4,000       | +4,000       | +4,000       | +4,000       | +4,000       |
| ONCALL 200.00     | FIXED_ALLOWANCE | +200         | +200         | +200         | +200         | +200         |
| SUA 150.00        | FIXED_ALLOWANCE | +150         | +150         | +150         | +150         | +150         |
| TRANSPORT 150.00  | FIXED_ALLOWANCE | +150         | +150         | +150         | +150         | +150         |
| OT_1_5 288.45     | OVERTIME        | —            | +288.45      | +288.45      | +288.45      | —            |
| LOAN_REPAY 167.00 | LOAN_REPAYMENT  | —            | —            | —            | —            | —            |
| MEDICAL 93.50     | REIMBURSEMENT   | —            | —            | —            | —            | —            |
| **base**          |                 | **4,500.00** | **4,788.45** | **4,788.45** | **4,788.45** | **4,500.00** |

No decision is taken at this step. The result is four grid rows read left to right.

### Step 6 — contribute

| seq | contribution | base     | band                          | employee | employer |
| --- | ------------ | -------- | ----------------------------- | -------- | -------- |
| 10  | EPF          | 4,500.00 | ≤5,000, age <60 → 11% / 13%   | 495.00   | 585.00   |
| 20  | SOCSO        | 4,788.45 | 4,700.01–4,800.00, category 1 | 23.25    | 81.35    |
| 30  | EIS          | 4,788.45 | same band                     | 9.30     | 9.30     |
| 40  | PCB          | 4,788.45 | see below                     | 97.15    | —        |
| 50  | HRDF         | 4,500.00 | headcount 132 → 1%            | —        | 45.00    |

PCB: annualise 4,788.45 × 12 = 57,461.40. Reliefs 9,000 individual + 4,000 EPF (capped, from 495 × 12)

- 350 SOCSO/EIS (capped) = 13,350. Chargeable 44,111.40 → band 35,000–50,000 at 6% with constant +600
  → 1,165.73 for the year → /12 = 97.14 → rounded up to 5 cents = 97.15.

### Step 7 — settle

```
gross              4,000 + 200 + 150 + 150 + 288.45          = 4,788.45
statutory (ee)     495.00 + 23.25 + 9.30 + 97.15             =   624.70
other deductions   loan repayment                            =   167.00
payments           medical claim                             =    93.50
net                4,788.45 − 624.70 − 167.00 + 93.50        = 4,090.25
employer cost      585.00 + 81.35 + 9.30 + 45.00             =   720.65
```

### Step 8 — the payslip

```
EARNINGS
  Basic salary                                     4,000.00
  On-call allowance                                  200.00
  Shift allowance                                    150.00
  Transport allowance                                150.00
  Overtime            10.0 h × 1.5 × 19.23           288.45
                                                ───────────
  Gross pay                                        4,788.45

DEDUCTIONS
  EPF                       on 4,500.00             (495.00)
  SOCSO                     on 4,788.45              (23.25)
  EIS                       on 4,788.45               (9.30)
  PCB                       on 4,788.45              (97.15)
  Staff loan repayment             3/12             (167.00)

PAYMENTS
  Medical claim                  #4471                93.50
                                                ───────────
  NET PAY                                          4,090.25

EMPLOYER  EPF 585.00 · SOCSO 81.35 · EIS 9.30 · HRDF 45.00      720.65

LEAVE     Annual 8.0 days · Sick 22.0 days
```

The leave figures were computed when the payslip was rendered. No row stores them and nothing ran to
produce them.

---

# Part 2 — The cases that usually need special code

## 2.1 Nihon's configuration, in total

| product, once for Malaysia | rows | Nihon, once             | rows |
| -------------------------- | ---- | ----------------------- | ---- |
| `jurisdictions`            | 1    | `companies`             | 1    |
| `statutory_contributions`  | 5    | `pay_components`        | 14   |
| `contribution_rates`       | ~180 | `leave_types`           | 8    |
| `component_types` (global) | 17   | company `accrual_bands` | 11   |
| `contribution_treatments`  | 80   | `shift_definitions`     | 4    |
| `overtime_rules`           | 6    | `company_holidays`      | ~16  |
| `overtime_limits`          | 1    |                         |      |
| statutory `accrual_bands`  | 9    |                         |      |

Statutory questions Nihon answered: none. Overtime multipliers Nihon typed: none.

Nihon's pay components:

| code                   | component type     | input                                   |
| ---------------------- | ------------------ | --------------------------------------- |
| HOURLY_RATE            | INFORMATION        | FORMULA                                 |
| BASIC                  | BASIC_SALARY       | FORMULA                                 |
| ONCALL, SUA, TRANSPORT | FIXED_ALLOWANCE    | ENTRY                                   |
| ATTENDANCE             | VARIABLE_ALLOWANCE | ENTRY                                   |
| OT_1_5                 | OVERTIME           | OVERTIME → ORDINARY beyond normal       |
| RD_HALF, RD_FULL       | VARIABLE_ALLOWANCE | OVERTIME → REST_DAY from 0, from 0.5    |
| OT_2_0                 | OVERTIME           | OVERTIME → REST_DAY beyond normal       |
| PH_DAY                 | VARIABLE_ALLOWANCE | OVERTIME → PUBLIC_HOLIDAY from 0        |
| OT_3_0                 | OVERTIME           | OVERTIME → PUBLIC_HOLIDAY beyond normal |
| OT_EXCESS_*            | OVERTIME           | derived 12 h/day or 104 h/month surplus |
| PINCEN (report output) | —                  | sum of derived statutory-excess lines   |
| BONUS                  | BONUS              | ENTRY                                   |
| NPL                    | UNPAID_ABSENCE     | FORMULA                                 |
| MEDICAL                | REIMBURSEMENT      | ENTRY                                   |
| LOAN_REPAY             | LOAN_REPAYMENT     | SCHEDULE                                |

## 2.2 Rahim — shift work and rest-day overtime

Hire 2019-04-01 (81 months), age 41, MANUAL, basic 2,200, shift B 15:00–23:00 with a 45-minute break,
rostered Monday to Saturday.

| date   | day type       | why                               | clock       | beyond shift |
| ------ | -------------- | --------------------------------- | ----------- | ------------ |
| 05 Jan | ORDINARY       | roster row exists                 | 15:00–01:30 | 2.5 h        |
| 11 Jan | REST_DAY       | no roster row, not in the pattern | 08:00–14:00 | 6.0 h worked |
| 01 Jan | PUBLIC_HOLIDAY | in `company_holidays`             | 15:00–00:00 | 1.0 h        |
| 14 Jan | ORDINARY       | roster row exists                 | 15:00–21:00 | —            |

Day type is derived; a holiday gazetted late is picked up on the next calculation.

```
HOURLY_RATE = 2,200 / 26 / 8 = 10.58

05 Jan  2.5 h ordinary day        → OT_1_5 = 2.5 × 1.5 × 10.58 =  39.68
01 Jan  1.0 h public holiday      → OT_3_0 = 1.0 × 3.0 × 10.58 =  31.74
11 Jan  6.0 h of 8 normal = 0.75  → overtime_rules REST_DAY 0.5–1.0,
                                     DAY_WAGE_MULTIPLE 1.0
                                   → RD_FULL = one day's wages    84.62
```

Through the grid:

| line           | type               | EPF    | SOCSO  | EIS    | PCB    | HRDF   |
| -------------- | ------------------ | ------ | ------ | ------ | ------ | ------ |
| BASIC 2,200.00 | BASIC_SALARY       | +2,200 | +2,200 | +2,200 | +2,200 | +2,200 |
| SUA 180.00     | FIXED_ALLOWANCE    | +180   | +180   | +180   | +180   | +180   |
| RD_FULL 84.62  | VARIABLE_ALLOWANCE | +85    | +85    | +85    | +85    | —      |
| OT_1_5 39.68   | OVERTIME           | —      | +40    | +40    | +40    | —      |
| OT_3_0 31.74   | OVERTIME           | —      | +32    | +32    | +32    | —      |

Rest-day work is in the EPF base because it is a variable allowance, not overtime. The two overtime
lines are not. No Nihon configuration states this.

## 2.3 Faridah — manager, no overtime, higher EPF band

Hire 2016-02-01 (119 months), age 47, MANAGERIAL, basic 9,500, `overtime_eligible = false`.

`OT_1_5`, `OT_2_0` and `OT_3_0` require `work_classification IN [MANUAL, NON_MANUAL]` and
`overtime_eligible = true`. Faridah matches neither, so the components are **not processed** — no line,
no zero row, no `if manager` anywhere.

| contribution | base  | band                                                         | result                    |
| ------------ | ----- | ------------------------------------------------------------ | ------------------------- |
| EPF          | 9,500 | >5,000 → RM 100 increments, 9,400.01–9,500.00, 11% / **12%** | ee 1,045.00 · er 1,140.00 |
| SOCSO        | 9,500 | the terminal band, 6,000–null                                | ee 29.75 · er 104.15      |

12% rather than 13% because the band row says so. No formula compares anything to 5,000, and no
formula wrote `min(base, 6000)` — the table simply ends.

## 2.4 Mr Tan — age 61

Hire 2009-08-01, age 61 at 31 January 2026, basic 3,800.

| contribution | age rule                      | employee | employer                |
| ------------ | ----------------------------- | -------- | ----------------------- |
| EPF          | `age_from 60` row, Part E     | 0.00     | ⌈3,800 × 0.04⌉ = 152.00 |
| SOCSO        | `age_from 60` row, category 2 | 0.00     | 47.55                   |
| EIS          | `age_from 60` row, not liable | 0.00     | 0.00                    |
| PCB          | unaffected                    |          |                         |

Three different age rules, three rate rows, zero conditionals. The word "60" appears in data and
nowhere else.

## 2.5 Siti — joined 12 January

Hire 2026-01-12, age 24, NON_MANUAL, basic 3,000, transport 150 standing, medical claim 60.00 on 20
January.

| line      | calculation                 | amount   |
| --------- | --------------------------- | -------- |
| BASIC     | 3,000 × 20/31               | 1,935.48 |
| TRANSPORT | 150 × 20/31, standing entry | 96.77    |
| MEDICAL   | one-off, never prorated     | 60.00    |

Her leave on 20 January, with nothing having run:

| leave type | resolution                                                                                                                                            | balance         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| ANNUAL     | eligible; entitlement `max(statutory 8, Nihon 12) = 12`; accrued from `max(1 Jan, hire 12 Jan)` = 12/12 × 20/31 = 0.65 → 0.5; carried in 0, expired 0 | **0.5 days**    |
| SICK       | UPFRONT, band(0) = 14                                                                                                                                 | **14.0 days**   |
| MATERNITY  | eligible (female), 105 days, PER_EVENT                                                                                                                | no balance      |
| PATERNITY  | not eligible (male)                                                                                                                                   | does not appear |
| STUDY      | not eligible (probation, < 24 months)                                                                                                                 | does not appear |

No assignment was made and no accrual ran. The figures are correct nine days after she started.

## 2.6 Kumar — three days unpaid leave

Basic 2,800, three unpaid days on 6–8 January, approved.

```
1  the request writes 3 TAKEN rows; request and rows share one approval id
2  the run reads leave.days('UNPAID')                        = 3.0
3  NPL   daily = round(2,800 / 31) = 90.32
         NPL   = round(3 × 90.32)  = 270.96      a positive magnitude
4  nature ABSENCE                                 ──► gross − 270.96
5  UNPAID_ABSENCE × every contribution = REDUCE
```

| base  | before   | after    |
| ----- | -------- | -------- |
| EPF   | 2,800.00 | 2,529.04 |
| SOCSO | 2,800.00 | 2,529.04 |
| PCB   | 2,800.00 | 2,529.04 |
| HRDF  | 2,800.00 | 2,529.04 |

No "no-pay leave adjustment" component, no proration branch inside a statutory profile, no per-scheme
rule. One component, one type, one grid row saying `REDUCE` five times.

## 2.7 Lim — resigning 10 February

Hire 2018-06-01, basic 4,300, loan outstanding 1,670.

Leave, derived when the exit screen opens:

```
entitlement      service 92 months → Nihon band(60) = 21, statutory 16 → 21

carriedIn(2026)  closing(2025) = carriedIn(2025) 4.0 + accrued 21.0 − expired 0 − taken 17.5 = 7.5
                 min(7.5, carry limit 6)                                  =  6.0   (1.5 forfeited)
accrued(1 Jan → 10 Feb)  round½(21 × 41/365 of a year) ≈ round½(2.36)     =  2.5
expired          before 1 April                                           =  0
TAKEN 2026                                                                = −2.0
                                                                            ─────
final balance                                                                6.5 days
```

Final pay:

```
BASIC             4,300 × 10/28                            1,535.71
LEAVE_ENCASHMENT  6.5 × round(4,300/26) = 6.5 × 165.38     1,074.97
LOAN_REPAY        outstanding, future entries reversed    −1,670.00
```

`LEAVE_ENCASHMENT` is INCLUDE for EPF, SOCSO, EIS and PCB, EXCLUDE for HRDF — so the encashment is in
the EPF base, by the same grid. The ledger gets one `ENCASHMENT −6.5` row and closes at zero.

Nothing about termination is special-cased.

## 2.8 What ran in the background

Nothing. Every number above came from one of two places:

| written by a person                   | computed when read                                      |
| ------------------------------------- | ------------------------------------------------------- |
| a claim, a leave request, a timesheet | leave entitlement, accrual, carry-forward, expiry       |
| an HR adjustment, a loan agreement    | claim cap consumption, day type, hourly rate            |
| a payroll run someone started         | service months, age, headcount band, contribution bases |

There is no state a process is responsible for maintaining, so there is no state that can be stale. A
server down for a week returns with every balance correct. What _can_ be wrong is an input — a hire
date, a band, a roster — and those are visible, dated, approved rows that a person can fix, fixing
everything downstream at once.

---

# Part 3 — Singapore and Indonesia

## 3.1 The three countries as data

|                     | Malaysia                          | Singapore                       | Indonesia                               |
| ------------------- | --------------------------------- | ------------------------------- | --------------------------------------- |
| contributions       | 5 — EPF, SOCSO, EIS, PCB, HRDF    | 2 — CPF, SDL                    | 6 — Kesehatan, JHT, JP, JKK, JKM, PPh21 |
| monthly income tax  | yes, PCB withheld                 | **no** — self-assessed annually | yes, PPh 21 TER, reconciled in December |
| ordinary rate basis | 26 days (EA s.60I)                | 190.67 hours                    | 173 hours (PP 35/2021)                  |
| overtime bands      | 6 — day-wage and hourly scales    | 1 — single open band            | 5 — first hour, then subsequent         |
| annual leave floor  | 8 / 12 / 16 by service (EA s.60E) | 7 rising to 14 (EA s.43)        | 12 after 12 months (UU 13/2003 s.79)    |
| 13th-month payment  | `BONUS`, PCB SPECIAL              | `BONUS`, no tax effect          | `BONUS`, PPh21 SPECIAL (THR)            |

Nothing in that table is code. Every cell is rows.

## 3.2 The grid, three columns

The 17 component types are global; only the columns change.

| component type     | MY: EPF SOCSO EIS PCB HRDF | SG: CPF SDL | ID: KES JHT JP PPh21 |
| ------------------ | -------------------------- | ----------- | -------------------- |
| BASIC_SALARY       | INC INC INC INC INC        | INC INC     | INC INC INC INC      |
| FIXED_ALLOWANCE    | INC INC INC INC INC        | INC INC     | INC INC INC INC      |
| VARIABLE_ALLOWANCE | INC INC INC INC EXC        | INC INC     | EXC EXC EXC INC      |
| OVERTIME           | EXC INC INC INC EXC        | EXC EXC     | EXC EXC EXC INC      |
| BONUS              | INC INC INC SPECIAL EXC    | SPECIAL EXC | EXC EXC EXC SPECIAL  |
| BENEFIT_IN_KIND    | EXC EXC EXC INC EXC        | EXC EXC     | EXC EXC EXC INC      |
| UNPAID_ABSENCE     | RED RED RED RED RED        | RED RED     | RED RED RED RED      |
| REIMBURSEMENT      | EXC EXC EXC EXC EXC        | EXC EXC     | EXC EXC EXC EXC      |
| LOAN_REPAYMENT     | EXC EXC EXC EXC EXC        | EXC EXC     | EXC EXC EXC EXC      |

80 cells, 34 cells, 102 cells.

| SPECIAL rule              | jurisdiction      | handles                     |
| ------------------------- | ----------------- | --------------------------- |
| `ADDITIONAL_REMUNERATION` | MY, BONUS × PCB   | annualise-difference method |
| `ADDITIONAL_WAGE`         | SG, BONUS × CPF   | the separate AW ceiling     |
| `IRREGULAR_INCOME`        | ID, BONUS × PPh21 | THR taxed outside the TER   |

Read the `OVERTIME` row across: out of EPF in Malaysia, out of CPF in Singapore, out of every BPJS
scheme in Indonesia, and taxable in all three. Three different laws, one row each.

## 3.3 Singapore — Wei Ling

Hire 2023-06-01, age 34, citizen, basic S$5,000, transport S$200 standing, 44 h / 5 days.

Three structural differences:

**No monthly income tax.** There is no `WTAX` contribution row, so no tax line, no relief pool, no
year-to-date cascade and no monthly filing. A correction in Singapore has no tax cascade at all; the
IR8A is produced annually from the same `payslip_lines` by the same query.

**A wage ceiling that is not a band.** The CPF Ordinary Wage ceiling caps the monthly base and is the
terminal rate band. The Additional Wage ceiling caps the annual bonus base and depends on OW already
contributed — which is why `BONUS × CPF` is `SPECIAL(ADDITIONAL_WAGE)` and not `INCLUDE`.

**A contribution with a floor, a cap and a minimum.** SDL is 0.25% of the first S$4,500, minimum S$2,
maximum S$11.25 — three bands:

| band_from | band_to | award         |
| --------- | ------- | ------------- |
| 0         | 800     | FIXED 2.00    |
| 800       | 4,500   | PERCENT 0.25% |
| 4,500     | _null_  | FIXED 11.25   |

The payslip:

| step       | result                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| measure    | BASIC 5,000.00 · TRANSPORT 200.00                                                                           |
| accumulate | CPF base 5,200.00 · SDL base 5,200.00                                                                       |
| contribute | CPF: `min(5,200, OW ceiling)` , age ≤55 → ee 20% = 1,040.00, er 17% = 884.00. SDL: terminal band → er 11.25 |
| settle     | gross 5,200.00 · statutory (ee) 1,040.00 · net 4,160.00 · employer cost 895.25                              |

Her annual leave uses the same `accrual_bands` table, the same `max()` rule and the same ledger:

| owner        | band_from                             | days                                         |
| ------------ | ------------------------------------- | -------------------------------------------- |
| STATUTORY SG | 12 / 24 / 36 / 48 / 60 / 72 / 84 / 96 | 7 / 8 / 9 / 10 / 11 / 12 / 13 / 14 (EA s.43) |
| COMPANY      | 12                                    | 14 flat — more generous from year one        |

At 31 months: `max(statutory 8, company 14) = 14 days`. Only the rows differ.

## 3.4 Indonesia — Budi

Hire 2021-09-01, age 38, TK/0, basic Rp 10,000,000, 40 h / 5 days.

Four structural differences:

**Six contributions, four of them employer-only.**

| scheme    | employee | employer   | notes                         |
| --------- | -------- | ---------- | ----------------------------- |
| Kesehatan | 1%       | 4%         | base capped at Rp 12,000,000  |
| JHT       | 2%       | 3.7%       | no cap                        |
| JP        | 1%       | 2%         | base capped, annually revised |
| JKK       | —        | 0.24–1.74% | keyed by **risk class**       |
| JKM       | —        | 0.30%      |                               |
| PPh21     | TER      | —          |                               |

JKK is keyed by the employer's industry risk class — the fourth value of
`statutory_contributions.keyed_by`, with `companies.risk_class` supplying the match.

**Tax is a monthly estimate with an annual true-up.** PPh 21 uses the TER monthly effective rate from
January to November, then a full-year reconciliation in December. Same mechanism as Malaysian PCB's
year-to-date self-correction, with the true-up pinned to one month instead of spread.

**THR is mandatory and separately taxed.** One month's wage before the religious holiday, type
`BONUS`, `BONUS × PPh21 = SPECIAL(IRREGULAR_INCOME)` so it is taxed outside the TER, and
`BONUS × every BPJS scheme = EXCLUDE`.

**Overtime is banded by hour count** on an hourly rate of 1/173 of the monthly wage. Both facts are
jurisdiction rows: `ordinary_rate_basis = HOURS_PER_MONTH`, `ordinary_rate_divisor = 173`, and the
overtime rules band 0–1 h at 1.5 and 1 h onward at 2.0.

The payslip, with 3.0 h of ordinary-day overtime:

```
hourly rate  10,000,000 / 173 = 57,803        not /26 — the basis says HOURS

band 0–1 h   1.0 × 1.5 × 57,803  =    86,705
band 1–null  2.0 × 2.0 × 57,803  =   231,212
                                    ─────────
overtime                              317,917
```

| contribution | base                       | employee | employer |
| ------------ | -------------------------- | -------- | -------- |
| Kesehatan    | `min(10.0m, 12.0m cap)`    | 100,000  | 400,000  |
| JHT          | 10,000,000                 | 200,000  | 370,000  |
| JP           | within cap                 | 100,000  | 200,000  |
| JKK          | risk class II 0.54%        | —        | 54,000   |
| JKM          | 0.30%                      | —        | 30,000   |
| PPh21        | 10,317,917, TER category A | 206,358  | —        |

Gross 10,317,917 · statutory (ee) 606,358 · net 9,711,559 · employer cost 1,054,000.

---

# Part 4 — Things going wrong

## 4.1 Approved, then the wrong amount

Nurul's January medical claim was approved and paid at RM 180.00. The receipt was RM 108.00.

Has a `PAID` run consumed it? Yes.

```
Feb  entry  MEDICAL  180.00  origin { REVERSAL, reverses: the Jan entry }
Feb  entry  MEDICAL  108.00
```

Net effect on February −72.00. `REIMBURSEMENT` is EXCLUDE from every base, so no base moves. Cap
consumption drops from 180 to 108 automatically — it is a `SUM`, and the reversal cancels the
original. February's payslip shows both lines.

Had the error been on a **transport allowance** instead, `FIXED_ALLOWANCE` is INCLUDE in all five
bases, so February's EPF, SOCSO, EIS, PCB and HRDF bases each move by the difference. The reversal
travels the same grid row the original did.

| jurisdiction | filing consequence                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| MY           | EPF, SOCSO, EIS due on wages paid in the month → no amendment. PCB self-corrects through year-to-date → no amendment |
| SG           | no monthly tax → nothing to cascade                                                                                  |
| ID           | the December reconciliation absorbs it → no amendment                                                                |

## 4.2 Back payment

On 10 March, Nurul's salary rises from 3,600 to 4,100 effective 1 January.

```
Jan  should have been 4,100, paid 3,600  →  500
Feb  should have been 4,100, paid 3,600  →  500
                                            ─────
                                            1,000

Mar  entry  BASIC  1,000.00  origin { ARREARS, covers: [2026-01, 2026-02] }
```

The same pay component, hence the same component type, so the grid charges it identically. No arrears
component and no `CORRECTION` type.

March's payslip shows basic 4,100.00 and arrears 1,000.00. The EPF base becomes 5,250 including
allowances — which crosses the RM 5,000 threshold, so the employer rate for March is 12% rather than
13%. The band row decides that; no code compares anything to 5,000.

What also moved, correctly: `employment_terms` now says 4,100 from 1 January, so the hourly rate for
future overtime, the daily rate used by NPL, and leave encashment value on exit all change. Nothing
derived from it in the past changes, because past payslips are stored.

Indonesia differs in one respect: PPh 21's TER applies to the month's actual gross, so the arrears
month carries a higher TER band and December's reconciliation settles the year.

## 4.3 Joining late

Hafiz joins 18 March, basic RM 3,000, transport 150 standing, claim RM 90 on 25 March. Employed 14 of
31 days.

| line      | calculation                 | amount   |
| --------- | --------------------------- | -------- |
| BASIC     | 3,000 × 14/31               | 1,354.84 |
| TRANSPORT | 150 × 14/31, standing entry | 67.74    |
| MEDICAL   | one-off                     | 90.00    |

His statutory position on day one:

|            |                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| EPF        | base 1,422.58 → band 1,420.01–1,440.00 → ee 157, er 185                                                |
| SOCSO, EIS | tabled on 1,422.58                                                                                     |
| PCB        | annualised over 10 remaining periods, not 12 — `period.periods_remaining` is derived from the run date |
| HRDF       | headcount rises by one; the band is re-derived, not stored                                             |

His leave on day three, with nothing having run:

| leave  | resolution                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------- |
| ANNUAL | `max(statutory 8, Nihon 12) = 12`; accrued from `max(1 Jan, hire 18 Mar)` = 12/12 × 14/31 = 0.45 → **0.5 days** |
| SICK   | UPFRONT → **14.0 days**                                                                                         |
| STUDY  | eligibility `service ≥ 24` → does not appear                                                                    |

In Singapore the statutory floor is nil until three months' service and 7 thereafter — two more
`accrual_bands` rows. In Indonesia it is 12 days after 12 months' continuous service — one band row at
`band_from 12`, so his Indonesian counterpart accrues nothing until month 12.

## 4.4 Rejected, and the reservation

Nurul requests 5 more days on 21 January while 2 days are still pending.

```
projected  = every ledger row, pending included   = 4.0
requested                                          = 5.0
4.0 < 5.0                                          ──► REFUSED
```

Checked against settled (6.0) both requests would approve and leave her one day overdrawn.
Write-then-lock is what makes a pending request reserve its days.

If the pending request is rejected, its two `TAKEN` rows roll back from typed temporal history — they were creates,
so they are deleted. Projected returns to 6.0. Nothing else changes, and there is no rejected row to
clean up.

---

# Part 5 — What the simulation changed

Held without modification: the 17-type list, the four treatments, `max(statutory, company) + Σ
individual`, the eight-step run, the three-kind ledger, corrections by compensating entry.

Two changes were forced:

| change                                    | why                                                                                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jurisdictions.ordinary_rate_basis`       | Malaysia divides by 26 **days**, Indonesia by 173 **hours**. A single numeric divisor could not express both.                                                           |
| `overtime_rules.band.measure` and `.unit` | Malaysia bands rest-day work as fractions of a normal day from its start; Indonesia bands the first hour beyond normal. Fractions alone could not say "the first hour". |

One thing to watch: JKK is keyed by industry risk class — not wage, age or headcount. That is a fourth
`keyed_by` value and a `companies.risk_class` column. It costs one enum value and one column, but it
is a genuine new key dimension rather than a rate change.
