# 06 — Time and overtime

This is a canonical chapter of the payroll architecture.

Clocks become hours; hours become money. Overtime is the one place payroll depends on what actually
happened rather than what was agreed.

---

## 1. The chain

```
shift_definitions  ┐
roster_entries     ├──►  day_type  ──►  time_entries  ──►  overtime lines
company_holidays   ┘     derived         clocks, breaks     statutory multiple
```

`day_type` is not stored. It is decided at calculation time, so a roster correction or a newly
gazetted public holiday is picked up without rewriting anything.

---

## 2. Day type

`dayType(employment, date)`, in order:

| #   | test                                                                                      | result           |
| --- | ----------------------------------------------------------------------------------------- | ---------------- |
| 1   | in `company_holidays` for this location                                                   | `PUBLIC_HOLIDAY` |
| 2   | a `roster_entries` row exists                                                             | `ORDINARY`       |
| 3   | no roster, but the weekday falls inside `terms.working_days_per_week` counted from Monday | `ORDINARY`       |
| 4   | otherwise                                                                                 | `REST_DAY`       |

One function covers rostered and non-rostered staff. A 250-row-per-person-per-year roster is never
generated for someone who works a fixed week.

---

## 3. Clocks to hours

Work date 2026-01-06, `ORDINARY`, shift 09:00–18:00 with a 60-minute break, clocked 08:42–21:15.

```
08:42      09:00           13:00 14:00          18:00        21:15
  │          │               │     │              │            │
  ├─ clamp ──┼═══ 4h ════════╪break╪═══ 4h ═══════┼─── OT ─────┤
  early      └──── 8h ordinary ────┘              │   3.25h    │
  discarded
```

Rules, in order:

1. clamp `clock_in` forward to shift start, `clock_out` back to shift end for the ordinary portion
2. subtract breaks that **overlap** the worked span, not a flat deduction
3. overtime = `clock_out` − shift end
4. floor overtime to the nearest 0.5 h
5. if 0 < overtime < 1.0, pay a minimum of 1 h

Step 2 is an overlap because a night shift crossing midnight has a break that may fall outside the
worked span; subtracting it unconditionally yields the wrong hours.

There is no separate overtime punch. The clock is the record, and authorisation is the time entry's
own approval stamp — unapproved time is invisible to payroll, so unauthorised overtime is never paid.

---

## 4. What overtime is worth

The multiplier is statute, not company policy. `overtime_rules` sits at jurisdiction level, one row
per day type and hour band, with the section that mandates it.

### Malaysia

| day type       | measure           | unit     | from | to     | award             | value | authority        |
| -------------- | ----------------- | -------- | ---- | ------ | ----------------- | ----- | ---------------- |
| ORDINARY       | BEYOND_NORMAL     | hours    | 0    | _null_ | HOURLY_MULTIPLE   | 1.5   | EA s.60A(1)(a)   |
| REST_DAY       | FROM_START_OF_DAY | fraction | 0    | 0.5    | DAY_WAGE_MULTIPLE | 0.5   | EA s.60(3)(a)(i) |
| REST_DAY       | FROM_START_OF_DAY | fraction | 0.5  | 1.0    | DAY_WAGE_MULTIPLE | 1.0   | EA s.60(3)(a)(i) |
| REST_DAY       | BEYOND_NORMAL     | hours    | 0    | _null_ | HOURLY_MULTIPLE   | 2.0   | EA s.60(3)(b)    |
| PUBLIC_HOLIDAY | FROM_START_OF_DAY | fraction | 0    | 1.0    | DAY_WAGE_MULTIPLE | 2.0   | EA s.60D(3)(a)   |
| PUBLIC_HOLIDAY | BEYOND_NORMAL     | hours    | 0    | _null_ | HOURLY_MULTIPLE   | 3.0   | EA s.60D(3)(b)   |

`award` is why rest days and holidays are not merely bigger multipliers:

| award               | pays                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `HOURLY_MULTIPLE`   | hours in band × multiple × ordinary rate of pay                   |
| `DAY_WAGE_MULTIPLE` | multiple × one day's wages, flat, regardless of hours in the band |

### Indonesia — PP 35/2021, banded by hour count

| day type | measure       | from | to     | award           | value |
| -------- | ------------- | ---- | ------ | --------------- | ----- |
| ORDINARY | BEYOND_NORMAL | 0 h  | 1 h    | HOURLY_MULTIPLE | 1.5   |
| ORDINARY | BEYOND_NORMAL | 1 h  | _null_ | HOURLY_MULTIPLE | 2.0   |
| REST_DAY | BEYOND_NORMAL | 0 h  | 8 h    | HOURLY_MULTIPLE | 2.0   |
| REST_DAY | BEYOND_NORMAL | 8 h  | 9 h    | HOURLY_MULTIPLE | 3.0   |
| REST_DAY | BEYOND_NORMAL | 9 h  | _null_ | HOURLY_MULTIPLE | 4.0   |

### Singapore — EA s.38, one open band

| day type | measure       | from | to     | award           | value |
| -------- | ------------- | ---- | ------ | --------------- | ----- |
| ORDINARY | BEYOND_NORMAL | 0 h  | _null_ | HOURLY_MULTIPLE | 1.5   |

Malaysia bands rest-day work as fractions of a normal day from its start. Indonesia bands the first
hour beyond normal separately. Singapore has one open band and no rest-day scale. No engine code
branches on country.

---

## 5. How a company maps to the rules

A company does not write multipliers. It declares which pay component pays which statutory rule.

| code      | `definition.rule`            | component type     | `definition.minimum` |
| --------- | ---------------------------- | ------------------ | -------------------- |
| `OT_1_5`  | ORDINARY from 1.0            | OVERTIME           | —                    |
| `RD_HALF` | REST_DAY from 0              | VARIABLE_ALLOWANCE | —                    |
| `RD_FULL` | REST_DAY from 0.5            | VARIABLE_ALLOWANCE | —                    |
| `OT_2_0`  | REST_DAY beyond normal       | OVERTIME           | —                    |
| `PH_DAY`  | PUBLIC_HOLIDAY from 0        | VARIABLE_ALLOWANCE | —                    |
| `OT_3_0`  | PUBLIC_HOLIDAY beyond normal | OVERTIME           | —                    |

`DAY_WAGE_MULTIPLE` rules map to `VARIABLE_ALLOWANCE` components: a rest day worked is remuneration
for a day, not an overtime premium, and the grid treats it accordingly — it is in the EPF base where
overtime is not.

### Completeness

For every `overtime_rules` row in the company's jurisdiction, exactly one pay component must map to
it. Missing → **BLOCKED**: _"MY defines REST_DAY 0–0.5 (half a day's wages); this company has no
component for it. Rest-day work under four hours would be unpaid."_

This is the same failure the treatment grid prevents for contributions: a legal obligation silently
not paid.

### Paying more than statute

`definition.minimum` resolves by R3: `max(statutory value, company minimum)`.

- Nihon pays 2.0× on ordinary-day overtime instead of 1.5× → `max(1.5, 2.0) = 2.0`, permitted.
- A company setting 1.25 → `max(1.5, 1.25) = 1.5`. Underpayment is not expressible.

---

## 6. Applying the rules to a day

Rahim, shift of 8 normal hours, rest day, worked 6.0 h, ORP 10.58, day wage 84.62.

```
1  dayType                                    ──► REST_DAY
2  hours worked after clamping and breaks     ──► 6.0
3  as a fraction of normal hours              ──► 0.75
4  bands spanned
     REST_DAY 0   – 0.5   fully entered
     REST_DAY 0.5 – 1.0   partially entered
     REST_DAY beyond normal   not entered
   the highest band entered wins for DAY_WAGE_MULTIPLE — a day's wages is not paid twice
                                              ──► 1.0 × 84.62 = 84.62
5  routed to the mapped component             ──► RD_FULL 84.62
```

Ordinary day, shift 8 h, worked 10.5 h:

```
3  10.5 / 8 = 1.3125
4  ORDINARY beyond normal, HOURLY_MULTIPLE 1.5; hours in band = 2.5
5  OT_1_5 = round(2.5 × 1.5 × 10.58) = 39.68
```

---

## 7. Caps

| control                                | level                                  | consequence                                                                                  |
| -------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| statutory boundary — MY 12 h total/day | `OVERTIME_EXCESS` component definition | the half-hour-floored surplus is reclassified at the same legal value; it is never discarded |
| statutory limit — MY 104 h/month       | `overtime_limits`, `on_exceed = WARN`  | ordinary/off-day OT above the calendar-month limit is reclassified and warned                |

An 11-hour working day is below the 12-hour boundary even when it contains more than four OT hours.
A 13-hour working day moves exactly 1.0 hour to statutory excess. Nihon's source `PINCEN` is a
post-run comparison value, not an input and not evidence of a company four-hour rule.

---

## 8. The ordinary rate of pay

```
monthly-rated:  ORP = base_salary / jurisdiction.ordinary_rate_divisor
                      / (ordinary_hours_per_week / working_days_per_week)
```

| jurisdiction | basis           | divisor | authority                |
| ------------ | --------------- | ------- | ------------------------ |
| MY           | DAYS_PER_MONTH  | 26      | EA s.60I                 |
| ID           | HOURS_PER_MONTH | 173     | PP 35/2021               |
| SG           | HOURS_PER_MONTH | 190.67  | 12 × monthly ÷ (52 × 44) |

Ahmad: 4,000 / 26 = 153.85 per day; 153.85 / 8 = 19.23 per hour (48 h week ÷ 6 days).

The divisor is statutory and lives on `jurisdictions`. A company using 30 instead of 26 would underpay
every overtime hour by 15%.

---

## 9. Window

Overtime worked 22 Dec – 21 Jan is paid in January; 22 Jan onward in February. Time entries are
selected by `work_date` against the run's attendance window, never by `pay_period`.
