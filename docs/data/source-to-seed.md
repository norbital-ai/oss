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

## Explicitly authorised entries when trackers disagree

An amount may appear on a source payslip but disagree with its specialist tracker. Prefer the
tracker when it matches the paid listing. When HR confirms a different paid amount with supporting
evidence, seed the **paid** amount and document the reason — do not invent a tracker receipt date
and do not leave the payslip amount as an unexplained gap.

Example: employee `NHPMY0053` has January medical RM93.50 on the salary listing (`JAN 2026!X5`).
The medical tracker also lists RM158 for January 2026 and RM215 for December 2025. The supporting
medical claim form shows the original claim RM158 struck through and replaced with RM93.50 because
the **2025 annual medical balance** remaining was RM93.50. Seed RM93.50 with that provenance; do
not invent a missing receipt date beyond the settlement window.

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
