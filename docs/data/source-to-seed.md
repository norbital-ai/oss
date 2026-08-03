# Source-to-seed contract

## Three field classes

| Class                     | Examples                                                                                                        | Seed rule                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Supplied input            | employee master, terms, shift assignment, attendance, approved leave, claim, allowance, loan agreement/schedule | Map one-to-one with provenance; normalise representation only                           |
| Derivable input structure | roster day generated from a supplied shift assignment and calendar                                              | Generate only when the governing source rule is present and retain the source code/date |
| Payroll output            | basic earned, OT amount, incentive OT, NPL amount, contributions, tax, gross, net, YTD                          | Never seed; calculate and compare                                                       |

The source payslip is test evidence, not seed. A matching output amount is not permission to copy it
back into an input table.

## Allowed cleaning

- unmerge cells and repeat employee identifiers on every dated row;
- use consistent sheet names and headers;
- preserve numbers as numbers, dates as dates and codes as text;
- remove decorative, empty and repeated-header rows;
- split a visually grouped block into one row per business record; and
- record original workbook, sheet, cell/row and file hash.

Cleaning must not calculate OT, infer a missing shift, convert leave, change a claim amount, invent a
transaction date or silently fill an employee master field. If source files conflict, both facts are
retained and the conflict is reported.

## Explicitly inferred entries

An amount may appear on a source payslip but be absent from its specialist tracker. It is not seeded
by default. If the business explicitly authorises matching it, create an entry with:

- the exact payslip amount;
- a date inside the applicable settlement window;
- a description beginning `INFERRED` and naming the source payslip cell; and
- no claim that the invented date came from the tracker.

Example: employee `ACME0042` has a January medical reimbursement of RM93.50 on the payslip and in
the allowance report, but neither medical tracker contains the event. Without explicit authorisation
the item remains an input gap and a variance — it must not be reverse-seeded from the payslip alone.

## Cutoff representation

Preserve both the event date and settlement assignment:

```text
event_date = when the attendance, claim, leave or instalment occurred
pay_period = explicit payroll assignment, when supplied
```

Do not move an event date to force it through a cutoff. Attendance is selected by the configured
21st–20th window. Component entries use explicit `pay_period` when present; otherwise their default
cutoff rule applies.

## Source-specific boundaries

- Paper January OT claims are corroborating evidence. Attendance remains the time input; a paper
  form never seeds an OT amount.
- Shift codes `01` and `10` remain source codes. Their roster/OT behaviour must come from the
  confirmed shift definition, not from a guessed label.
- OIL is calculated from holiday/rest-day rules when applicable. No missing OIL award transaction
  is fabricated.
- A late-joiner backpay derived from hire date and salary is output. A separately supplied historical
  statutory correction is input.
- Unsupported loan schedules are excluded rather than altered to make the totals fit.

## Completeness rule

The audit report must list every source record that cannot be seeded and every required payroll
input family that was not supplied. “No discrepancy” means exact cleaned-to-seed coverage within the
declared boundary; it does not mean that missing business documents were guessed.
