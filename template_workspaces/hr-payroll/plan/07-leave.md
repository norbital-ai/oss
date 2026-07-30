# 07 — Leave

Three separate questions, usually confused with each other:

| question                                     | answered by                   | is         |
| -------------------------------------------- | ----------------------------- | ---------- |
| does this person get this leave type at all? | `leave_types.eligibility`     | a filter   |
| how many days?                               | `accrual_bands`, three layers | a number   |
| when do the days arrive?                     | `leave_types.accrual`         | a schedule |

And one more, answered by the ledger: how many are left.

---

## 1. Who gets which leave type

`leave_types.eligibility` is a rule list. All must match; no rules means everyone. Attributes are a
closed set:

`employee.gender` · `employee.marital_status` · `employee.nationality` ·
`employee.dependents_count` · `derived.age` · `derived.service_months` ·
`employment.work_classification` · `employment.employment_type` · `employment.company_id`

Operators: `=` `≠` `IN` `NOT_IN` `≥` `<`

### Nihon's leave types

| leave type      | eligibility                                             |
| --------------- | ------------------------------------------------------- |
| ANNUAL          | —                                                       |
| SICK            | —                                                       |
| HOSPITALISATION | —                                                       |
| MATERNITY       | `gender = FEMALE`                                       |
| PATERNITY       | `gender = MALE` and `marital_status = MARRIED`          |
| COMPASSIONATE   | —                                                       |
| STUDY           | `employment_type = PERMANENT` and `service_months ≥ 24` |
| UNPAID          | —                                                       |

Ahmad — male, married, permanent, 66 months — qualifies for 7 of 8; maternity does not apply. Siti —
female, married, probation, 4 months — qualifies for 6 of 8; paternity and study do not.

**Leave types are not assigned to people.** The rule is evaluated wherever leave is displayed,
requested or accrued. Siti becoming permanent at month 24 gains study leave that month with no HR
action.

There is no assignment table and no exception table. A genuine individual exception is an
`ADJUSTMENT` row on the ledger — dated, approved, carrying its reason. One row per employee there
means the eligibility rule is wrong.

---

## 2. How many days

`accrual_bands`, chosen by a key.

### Banded by service — annual leave

| owner         | band_from (months) | days | authority      |
| ------------- | ------------------ | ---- | -------------- |
| STATUTORY MY  | 0                  | 8    | EA s.60E(1)(a) |
| STATUTORY MY  | 24                 | 12   | EA s.60E(1)(b) |
| STATUTORY MY  | 60                 | 16   | EA s.60E(1)(c) |
| COMPANY Nihon | 0                  | 12   | policy         |
| COMPANY Nihon | 24                 | 16   | policy         |
| COMPANY Nihon | 60                 | 21   | policy         |

### Flat — maternity

| owner         | key  | days | authority |
| ------------- | ---- | ---- | --------- |
| STATUTORY MY  | FLAT | 98   | EA s.37   |
| COMPANY Nihon | FLAT | 105  | policy    |

`key: FLAT` means one row and every eligible person gets the same number. There is no band bound to
leave empty.

### The three layers

```
entitlement = max( statutory band, company band ?? statutory band )
```

| leave                     | statutory | company | resolved |
| ------------------------- | --------- | ------- | -------- |
| ANNUAL, Ahmad (66 months) | 16        | 21      | 21       |
| MATERNITY, Siti           | 98        | 105     | 105      |
| SICK, Ahmad               | 22        | 22      | 22       |

If Nihon mis-typed maternity as 60, `max(98, 60) = 98`. Compliance does not depend on the customer
configuring correctly.

The individual layer does not change the entitlement — it adds days to the ledger as an `ADJUSTMENT`.
Same effect, one less resolution rule, and the reason is recorded.

---

## 3. When the days arrive

`leave_types.accrual`, one field, three values:

| kind        | means                                          | used by                                     |
| ----------- | ---------------------------------------------- | ------------------------------------------- |
| `MONTHLY`   | entitlement × elapsed months / 12              | annual leave — accrues as you work          |
| `UPFRONT`   | the whole entitlement from the plan-year start | sick, compassionate, study                  |
| `PER_EVENT` | granted when the event is recorded             | maternity, paternity — no balance, no carry |

### Nihon's full leave policy

| leave type      | eligibility            | company band            | accrual   | carry                          |
| --------------- | ---------------------- | ----------------------- | --------- | ------------------------------ |
| ANNUAL          | —                      | 12 / 16 / 21 by service | MONTHLY   | 6 days, expires after 3 months |
| SICK            | —                      | 14 / 18 / 22 by service | UPFRONT   | none                           |
| HOSPITALISATION | —                      | 60 flat                 | UPFRONT   | none                           |
| MATERNITY       | female                 | 105 flat                | PER_EVENT | —                              |
| PATERNITY       | male, married          | 7 flat                  | PER_EVENT | —                              |
| COMPASSIONATE   | —                      | 3 flat                  | UPFRONT   | none                           |
| STUDY           | permanent, ≥ 24 months | 5 flat                  | UPFRONT   | none                           |
| UNPAID          | —                      | no entitlement          | —         | —                              |

Eight `leave_types` rows and eleven `accrual_bands` rows are the entire policy.

---

## 4. The ledger

A leave balance is a bank statement for days: store every movement, sum them. A stored
`annual_leave_remaining = 8.0` cannot answer _why 8?_, _what was it in March?_, _who gave me 3 extra?_
or _did my carried-over days expire?_ — and every process that changes it must remember to change it
correctly, forever, or it drifts.

### A ledger row

| field                            | notes                               |
| -------------------------------- | ----------------------------------- |
| `employment_id`, `leave_type_id` |                                     |
| `entry_date`                     | the date the movement belongs to    |
| `kind`                           | why it moved                        |
| `days`                           | signed: + adds, − takes away        |
| `source_id`                      | the request or event that caused it |
| `note`                           |                                     |
| `norbital_approval_id`           | null = in force, set = pending      |

Three rules, and they are the whole discipline: rows are only inserted, never updated, never deleted.

### Three kinds

| kind         | sign | written by       | when                  |
| ------------ | ---- | ---------------- | --------------------- |
| `TAKEN`      | −    | a leave request  | one row per leave day |
| `ADJUSTMENT` | ±    | HR               | any time              |
| `ENCASHMENT` | −    | the exit process | on final pay          |

Every one is a person doing something. No process writes to this table.

Not in the ledger, because all three are pure functions of the date: **accrual**
(entitlement × elapsed / 12), **carry-forward** (`min(last year's closing, carry limit)`) and
**expiry** (`max(0, carried in − taken before the expiry date)`).

---

## 5. Reading a balance

```
balance(D) = carriedIn(planYear(D))                 derived, §7
           + accrued(planYearStart → D)             derived
           − expired(D)                             derived
           + Σ ledger.days between planYearStart and D
```

| variant       | predicate                      | used by       |
| ------------- | ------------------------------ | ------------- |
| **settled**   | `norbital_approval_id IS NULL` | payroll       |
| **projected** | every row                      | a new request |

A request must check **projected**, because a pending request has already reserved its days. Settled
7.0, one 3-day request pending, asking for 5 more: against settled `7.0 ≥ 5.0` allows it and both
approvals leave the person 1.0 day overdrawn; against projected `4.0 < 5.0` refuses.

Also available: `… AND entry_date <= ?` for a balance as of a date.

---

## 6. A full year

Ahmad, annual leave, entitlement 21, carry limit 6, carry expires after 3 months.

**Stored:**

| date       | kind       | days | approval | note                  |
| ---------- | ---------- | ---- | -------- | --------------------- |
| 2026-02-14 | TAKEN      | −1.0 | null     | request #221          |
| 2026-02-15 | TAKEN      | −1.0 | null     | request #221          |
| 2026-06-10 | TAKEN      | −1.0 | set      | request #319, pending |
| 2026-06-11 | TAKEN      | −1.0 | set      | request #319, pending |
| 2026-06-12 | TAKEN      | −1.0 | set      | request #319, pending |
| 2026-08-02 | ADJUSTMENT | +3.0 | null     | long-service award    |

Six rows for the whole year.

**Derived, at any date asked:**

```
carriedIn(2026)          min(2025 closing 8.5, carry limit 6)  =  6.0
accrued(1 Jan → 31 Aug)  round½(21 × 8/12)                     = 14.0
expired(after 1 Apr)     max(0, 6.0 − taken before 1 Apr 2.0)  =  4.0
```

**Balance on 31 August:**

```
carried in     + 6.0
accrued       + 14.0
expired        − 4.0
TAKEN settled  − 2.0
ADJUSTMENT     + 3.0
               ──────
settled          17.0     payroll acts on this
TAKEN pending  − 3.0
               ──────
projected        14.0     a new request is checked against this
```

Every question is answerable: _how many can I book?_ projected. _Why did I lose four days in April?_
the expiry formula with its inputs. _Who gave me three days in August?_ the adjustment row and its
approval request. _What was my balance in March?_ the same formula with D = 31 March.

---

## 7. Accrual is derived

A balance that is only correct after a process has run is a cache, and caches go stale. Accrual is
therefore computed, never stored.

```
accrued(start → D) = round_half( Σ band(service_months at month m) / 12 )
                     m from max(planYearStart, hire_date) to min(D, exit_date)
```

A partial first or last month counts pro rata by the jurisdiction's proration method — which is why
there is no `prorate_on_hire` flag.

**Round the running total, never the monthly increment.**

| rounding the increment                      | rounding the running total      |
| ------------------------------------------- | ------------------------------- |
| 1.75 → 2.0 × 12 = 24.0, wrong by three days | Jan `round½(21 × 1/12)` = 2.0   |
|                                             | Feb `round½(21 × 2/12)` = 3.5   |
|                                             | Mar `round½(21 × 3/12)` = 5.5   |
|                                             | Dec `round½(21 × 12/12)` = 21.0 |

Monotonic, lands exactly on the entitlement, and is a pure function of the date.

### The three usual objections

| objection                   | answer                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| rounding compounds          | true only when the increment is rounded                                                                           |
| bands change mid-year       | the sum walks month by month and reads the band at each; still pure                                               |
| a ceiling makes it stateful | so there is no ceiling. The carry limit bounds accumulation at the one moment that matters, and it is derived too |

### Carry-forward is derived too

```
carriedIn(Y) = Y is the hire year ? 0 : min( closing(Y−1), carry_limit_days )
closing(Y)   = carriedIn(Y) + accrued(whole of Y) − expired(Y) + events(whole of Y)
```

Terminates at the hire year. A ten-year employee is ten levels of the same arithmetic — about 120 band
lookups and one ledger scan.

Storing a boundary row written on first read would still be scheduled work: a write inside a query
path, with a race between concurrent readers. Deriving it removes the row, the race and the write.

### The dependency list

|                 |                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| reads           | `employments.hire_date`, `employees.*` for eligibility, `leave_types` + `accrual_bands`, ledger rows |
| writes          | nothing, ever, except when a person does something                                                   |
| background work | none                                                                                                 |
| write-on-read   | none                                                                                                 |

The trade-off, stated once and applying everywhere: changing an input changes derived history. Correct
a hire date or a band and every past balance moves. When the past must stay still, date the change
forward and write an `ADJUSTMENT` — chapter [11](11-corrections.md) §4.

---

## 8. Resolving a balance, in full

| #   | step                                                                                 | Ahmad, 31 Aug |
| --- | ------------------------------------------------------------------------------------ | ------------- |
| 1   | eligible? `leave_types.eligibility` vs the person. No → there is no balance          | ✓             |
| 2   | carried in — `min(closing(Y−1), carry_limit_days)`, recursive to the hire year       | + 6.0         |
| 3   | accrued — `round_half(Σ band(service at m)/12)` from `max(planYearStart, hire_date)` | + 14.0        |
| 4   | expired — past the expiry date? `max(0, carried in − taken before it)`               | − 4.0         |
| 5   | events — Σ ledger days ≤ D; the approval predicate decides settled or projected      | + 1.0         |

Five steps of arithmetic over at most twelve months and a handful of rows — cheap enough to run on
every page load, which is why nothing needs caching.

`UPFRONT` types collapse step 3 to the entitlement for any D in the year. `PER_EVENT` types have no
step 3 at all.

### Why the band is read month by month

Siti crosses 24 months of service on 14 July:

```
Jan–Jun  band(0) = 12   ──►  1.0 / month  ──►  Σ 6.0
Jul–Dec  band(24) = 16  ──►  1.33 / month ──►  Σ 8.0
                                               round½(14.0) = 14.0
```

An annual snapshot would give her either 12 or 16 for the whole year. Walking the months is right, and
it prorates a mid-year joiner for free.

---

## 9. Carry-forward and expiry

**Carry-forward, 1 January.** `closing(2026) = 12.5`; `carriedIn(2027) = min(12.5, 6) = 6.0`;
forfeited 6.5. No row is written. Nothing runs on 1 January. The first person to ask for a 2027
balance computes it, and so does the second, identically.

**Expiry, 1 April** with `carry_expiry_months = 3`. Consumption is oldest-first: leave taken is charged
against carried-in days before this year's accrual.

```
carried in  6.0   ██████
taken       2.0   ██░░░░   ──► 4.0 of the carry-in is unused
accrued     6.0   ██████   ──► untouched

expired(D) = D past 1 Apr ? max(0, carriedIn − taken before 1 Apr) : 0
           = max(0, 6.0 − 2.0) = 4.0
```

Without oldest-first this would remove days already used, and the balance would be wrong by exactly
what was taken in Q1.

---

## 10. A leave request

```
1  CHECK    eligible?                                            ✓
            projected balance as of the last day               = 8.0
            requested                                          = 3.0

2  WRITE    the platform writes, then locks — all four rows share
            one norbital_approval_id:

              leave_requests  #319   10–12 Jun · reason · certificate
              leave_ledger    TAKEN  10 Jun −1.0
              leave_ledger    TAKEN  11 Jun −1.0
              leave_ledger    TAKEN  12 Jun −1.0

            one row per DAY, so balance-as-of works and payroll can select
            by period without parsing a range

3  RESOLVE  approved ──► the stamp clears; settled 8.0 → 5.0
            rejected ──► all four rows roll back from typed temporal history; they were
                         creates, so they are deleted. Projected returns to
                         8.0 and the reservation is released.
```

---

## 11. Per-event leave

Maternity, 105 days, no accrual, no carry-forward, no annual balance. The event is recorded and the
entitlement granted once:

```
2026-09-01  ADJUSTMENT  +105.0   "maternity, child 1"
2026-09-01  TAKEN         −1.0
…           (105 TAKEN rows)
2026-12-14  TAKEN         −1.0
                                  balance 0.0
```

The balance returns to zero when the leave is exhausted. There is nothing to carry and nothing to
expire.

---

## 12. Unpaid leave

The only leave that touches money, and it does so as an ordinary pay component.

```
leave_types                        pay_components
  code  UNPAID                       code  NPL
  payroll_effect                     component_type  UNPAID_ABSENCE
    { kind: UNPAID,      ──────────► definition { source: FORMULA, … }
      component_id }
```

1. approval writes `TAKEN` rows, as any leave does
2. the run reads `leave.days('UNPAID')` for the period
3. `NPL`'s formula turns days into money:

```
round( leave.days('UNPAID') × round(terms.base_salary / period.calendar_days, CENT), CENT )

3 days · salary 4,000 · January 31 days
daily = round(4,000 / 31) = 129.03
NPL   = 3 × 129.03        = 387.09      a positive magnitude
```

4. nature `ABSENCE` → gross − 387.09
5. grid row `UNPAID_ABSENCE × every contribution = REDUCE` → every base − 387.09

The daily rate is rounded to the cent **before** multiplying — a published-rate convention. Any
back-solving of days from an amount must use the same boundary.

There is no separate proration path and no statutory-profile arithmetic. One component, one type, one
grid row.

---

## 13. Encashment on exit

With `encash_on_exit = true`:

```
final balance   settled ledger                             8.5 days
daily rate      round(base_salary / 26, CENT)               153.85
encashment      8.5 × 153.85                              1,307.73
```

Two rows under one approval: `leave_ledger ENCASHMENT −8.5` takes the balance to zero, and a
`component_entry` on a `LEAVE_ENCASHMENT` component carries 1,307.73 into payroll. The grid puts it in
the EPF, SOCSO, EIS and PCB bases and out of HRDF.

Nothing about termination is special-cased.

---

## 14. The boundary with payroll

| leave, its own cadence                    | payroll, monthly                |
| ----------------------------------------- | ------------------------------- |
| requests → `TAKEN` rows                   | reads `leave.days('UNPAID')`    |
| accrual, carry, expiry → derived, no rows | reads the final balance at exit |
| HR adjustments → `ADJUSTMENT` rows        | writes only `ENCASHMENT`        |

Paid leave has no payroll effect. The employee is paid their salary whether at their desk or on the
beach; only the ledger moves.
