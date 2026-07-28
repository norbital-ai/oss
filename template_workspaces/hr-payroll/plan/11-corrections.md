# 11 — Corrections

Two mechanisms. One question chooses between them: **has a `PAID` run already consumed it?**

| answer | mechanism                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| no     | edit or delete the row. The edit is itself approval-stamped: approved applies it, rejected rolls it back. The run recalculates. |
| yes    | the row is frozen. Write a compensating row in the next open period. It is itself approval-stamped. Both rows survive.          |

There is no correction run and no `corrects_run_id`. A `PAID` run is never re-run.

Why that is enough: EPF, SOCSO and EIS are due on wages _paid_ in a month, so a correction paid in
March is a March liability and nothing is amended. PCB is an estimate of an annual tax and
self-corrects through year-to-date. A jurisdiction demanding amended filings for the original period
would need a settled period re-run; Malaysia does not.

---

## 1. Compensating entries

Every "already paid" case is a **reversal** of what was wrong plus a **fresh entry** for what was
right. Either may be absent.

### Wrong amount

January paid a RM 300 allowance that should have been RM 200.

```
Feb  entry  ONCALL  300.00  origin { REVERSAL, reverses: the Jan entry, reason }
Feb  entry  ONCALL  200.00
```

Net effect −100.00, and every base moves by −100.00 because the reversal runs through the same grid
row as the original.

### Should not have been paid

One reversal, no fresh entry.

### Backdated pay rise

On 10 March, a rise from 4,000 to 4,600 effective 1 January. Two months × 500 = 1,000.

```
Mar  entry  BASIC  1,000.00  origin { ARREARS, covers: [2026-01, 2026-02], reason }
```

The same pay component, hence the same component type, so the grid charges it identically. There is no
arrears component and no `CORRECTION` type: a correction is a kind of timing, not a kind of pay.

### Wrong component type

Six months of "Site Allowance" were typed `FIXED_ALLOWANCE` and should have been `OVERTIME`, so EPF was
over-charged throughout.

1. fix the pay component's type — future periods are correct at once
2. reverse the six old entries; they carry the type as paid
3. re-enter the six amounts on the corrected component

Every EPF base moves by the net difference in the current period. Over-contributed EPF is recovered
through the EPF board, not through payroll; the run report flags the delta for manual filing.

This is the most expensive mistake the system permits, which is why picking a type is a guided
decision (chapter [03](03-types-and-grid.md) §7) and not free text.

A reversal is not a negative amount. It is a normal entry whose `origin.kind` is `REVERSAL`; step 5
flips its sign when accumulating. That keeps amounts as magnitudes everywhere.

---

## 2. Leave corrections

The ledger is insert-only, so nothing is rewritten.

| situation                                | correction                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| not yet taken                            | delete the `TAKEN` rows. The delete is approval-stamped; a rejected delete restores them from `_history`                                                                                                |
| already taken, cancelled after the fact  | the days were genuinely not worked. If the company returns them, that is an `ADJUSTMENT` row, not a deletion                                                                                            |
| unpaid leave already in a `PAID` payslip | two rows under one approval: `ADJUSTMENT +3.0` on the ledger, and a reversal of the NPL amount. The reversal restores gross and every base, because it runs through the same grid row that reduced them |
| a wrong carry limit                      | nothing was stored, so nothing needs repairing. Correcting the leave type recomputes every dependent balance immediately, including last year's carry-forward                                           |

---

## 3. Derived values move silently

Accrual is computed, not stored (chapter [07](07-leave.md) §7). This removes all background work and
has one consequence.

Correcting `hire_date` from 2021-03-01 to 2020-09-01 adds six service months, changes the accrual band
for every month it crosses, and changes every past leave balance. No `ADJUSTMENT` row is written,
because nothing was stored to adjust — the balance becomes what it should always have been.

Usually that is right. When it is not — a balance already relied upon, or a closed leave year — use
the same rule as everywhere else:

1. date the change forward, so `effective_range` starts today
2. write an `ADJUSTMENT` row carrying the difference for the past
3. the row says why

Inputs that move derived history:

| input                                     | affects                         |
| ----------------------------------------- | ------------------------------- |
| `employments.hire_date`                   | service months, bands, accrual  |
| `employees.date_of_birth`                 | age, EPF/SOCSO/EIS category     |
| `accrual_bands.days`                      | accrual for every month covered |
| `leave_types.accrual.carry.expiry_months` | the expiry calculation          |

Everything a payroll run produced is stored, so **no payslip ever moves.** Only leave balances and
present-day derivations do.

---

## 4. Tax cascade

Changing a past period changes year-to-date, and PCB is calculated on year-to-date.

```
Jan  PCB  97.15   paid, unchanged
Feb  PCB  97.15   paid, unchanged
Mar  PCB 121.40   absorbs the Jan–Feb under-withholding
```

No amended CP39, no re-run. The estimate self-corrects because it was always an estimate of an annual
figure.

Singapore has no monthly income tax, so there is nothing to cascade. Indonesia's December
reconciliation absorbs it.

---

## 5. What may never be edited

| thing                                    | correction                      |
| ---------------------------------------- | ------------------------------- |
| a `PAID` payslip                         | compensating entry, next period |
| an entry consumed by a `PAID` run        | reversing entry                 |
| a `leave_ledger` row                     | compensating row                |
| a jurisdiction's ruleset                 | a new version with a new hash   |
| a configuration row used by a `PAID` run | end-date it, insert a successor |

Nothing supports `UPDATE` on a settled fact. Every correction is an append, approval-stamped, with a
reason.
