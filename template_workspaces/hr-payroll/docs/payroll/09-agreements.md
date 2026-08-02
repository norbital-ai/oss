# 09 — Repayment agreements

This is a canonical chapter of the payroll architecture.

A staff loan, a salary advance and an overpayment recovery are the same object: an agreement to deduct
a principal over time. Payroll never reads the agreement; it reads the entries the agreement
generated.

---

## 1. The mechanism

```
repayment_agreements #12
  reference     STAFF-2025-9
  principal     2,004.00
  disbursed     2025-11-01
  schedule      167.00 × 12, from 2025-12
  pay_component_id ──► LOAN_REPAY
                         definition.source = SCHEDULE
                         component_type    = LOAN_REPAYMENT
                         nature            = DEDUCTION
      │
      │  generated once, at approval
      ▼
component_entries
  2025-12  167.00  origin { INSTALMENT, agreement #12, seq 1, of 12 }
  2026-01  167.00  origin { INSTALMENT, agreement #12, seq 2, of 12 }
  …
  2026-11  167.00  origin { INSTALMENT, agreement #12, seq 12, of 12 }
      │
      │  a run picks up the row whose pay_period matches
      ▼
payslip_line  Staff loan repayment  167.00
  grid: EXCLUDE from every base · nature DEDUCTION → net −167.00
      │
      └── payslip_line_sources { COMPONENT_ENTRY, entry_id }
```

The agreement has an identity that outlives any instalment; each entry names it in its `origin`
variant. Materialising the schedule up front means the outstanding balance, the next instalment and
the final period are all queries over `component_entries` and their payslip source links — no second
ledger, no status column to keep in sync.

`component_entries.repayment_agreement_id` and `repayment_sequence` are generated, read-only
projections of the `INSTALMENT` origin. `payslip_line_sources.component_entry_id` is the corresponding
projection of the `COMPONENT_ENTRY` source. The JSON variants remain the audit record; the generated
keys add indexes, foreign keys and a direct nested-query path without becoming another writable fact.

A salary advance is an agreement with one instalment. An overpayment recovery is an agreement against
a recovery component. Same table, same shape.

---

## 2. Outstanding balance

```
paid        = Σ instalment.amount
              WHERE instalment.repayment_agreement_id = #12
                AND EXISTS instalment.entry_payslip_sources
outstanding = principal − paid
```

An instalment is paid when payroll has persisted a source link from a real payslip line to that
entry. A draft/paid lifecycle comparison is neither necessary nor sufficient: the link is the durable
evidence that the entry was actually consumed. Duplicate source rows do not double-count a schedule
sequence.

There is no `state` column: an agreement is settled when every scheduled sequence is linked and its
outstanding balance is zero. The Loans surface loads the agreement, employment, pay component,
instalments and their source links as one nested relational query.

---

## 3. Changing a live agreement

Three events, one mechanism: reverse and regenerate. Nothing is edited in place.

**Skip an instalment.** Write a reversing entry for the affected row —
`origin { REVERSAL, reverses: seq 4, reason }` — then regenerate the tail with one extra period.

**Early settlement.** Reverse every unpaid future entry, then write one entry for the outstanding
balance in the settling period.

**Reschedule.** Reverse every unpaid future entry, then generate a new schedule from the outstanding
balance. The agreement keeps its identity; the schedule is new.

A reversal is a row, so the history of what was owed and when survives every change.

---

## 4. Insufficient net

Chapter [05](05-payroll-run.md) §7 reduces deductions when net would go negative. Reducibility is
`definition.reducible` on the pay component.

```
gross 200.00 · statutory 22.00 · canteen 60.00 · loan instalment 167.00
net = 200 − 22 − 60 − 167 = −49.00

reduce in reverse component-type sequence:
  OTHER_DEDUCTION  60.00 ──► 11.00     (49.00 absorbed)
  LOAN_REPAYMENT  167.00 ──► untouched this time
net = 0.00
```

The 49.00 shortfall becomes an arrears entry on the next period, and the schedule extends by one
period.

`STATUTORY_ORDER` components carry `reducible: false`, so a court order cannot be shrunk by policy.

---

## 5. Exit recovery

Where company policy recovers on exit:

```
1  outstanding = 1,670.00
2  reverse all future scheduled entries
3  write one entry for 1,670.00 in the final period
4  the net guard applies; any residue becomes a receivable outside payroll,
   recorded explicitly on the run

final gross     4,309.67
encashment      1,307.73
statutory        −624.70
loan recovery  −1,670.00
                ─────────
net             3,322.70
```

---

## 6. What is not an agreement

| thing                     | why                                                                              |
| ------------------------- | -------------------------------------------------------------------------------- |
| court-ordered garnishment | type `STATUTORY_ORDER`, never reducible by the net guard                         |
| interest on a staff loan  | if below market, the benefit is taxable — a separate `BENEFIT_IN_KIND` component |
