# Statutory overtime coverage: what is encoded, and what is not

A survey prompted by the question _"check statutory law for OT and break time — manual labour vs
non-manual, RM4,000 minimum"_. It records only what this repository already contains. **No rate,
threshold or classification in this document was written from memory**, and none was added to seed,
model or code as a result of writing it. Where the answer needs a legal source the repository does
not carry, the entry says so and stops.

The RM4,000 figure and the manual/non-manual distinction the question points at are the Malaysian
Employment Act 1955 First Schedule scope test. **The template already applies both** — but as a
hard-coded literal in engine code rather than as effective-dated, cited data, which is a materially
different thing from the six overtime multipliers beside it.

## Encoded

### Overtime multipliers — `MY_OVERTIME_RULES`, six rows

Seeded in Core at `norbital/apps/core/seed/norbital_hr/statutory/rows.ts` (§4.4). The template
workspace ships no overtime seed of its own; it reads these rows from `overtime_rules`.

| Day type         | Band                                    | Award               | Cited authority        |
| ---------------- | --------------------------------------- | ------------------- | ---------------------- |
| `ORDINARY`       | beyond normal hours, `0 → ∞`            | `1.5 ×` hourly rate | EA 1955 s.60A(3)(a)    |
| `REST_DAY`       | from start of day, fraction `0 → 0.5`   | `0.5 ×` day wage    | EA 1955 s.60(3)(b)(i)  |
| `REST_DAY`       | from start of day, fraction `0.5 → 1.0` | `1.0 ×` day wage    | EA 1955 s.60(3)(b)(ii) |
| `REST_DAY`       | beyond normal hours, `0 → ∞`            | `2.0 ×` hourly rate | EA 1955 s.60(3)(c)     |
| `PUBLIC_HOLIDAY` | from start of day, fraction `0 → 1.0`   | `2.0 ×` day wage    | EA 1955 s.60D(3)(a)    |
| `PUBLIC_HOLIDAY` | beyond normal hours, `0 → ∞`            | `3.0 ×` hourly rate | EA 1955 s.60D(3)(aa)   |

Rest day has a half-day split; public holiday does not. `DAY_WAGE_MULTIPLE` is a flat fraction of a
day's wage; `HOURLY_MULTIPLE` is per hour — the two award kinds are different scales, not variants.
Each row carries its section number in `overtime_rules.authority`, which is free text and is the
only citation carrier in the data model.

### Overtime cap — one row

`MY_OVERTIME_LIMITS` holds a single row: `period: 'MONTH'`, `max_hours: 104`, `on_exceed: 'WARN'`,
cited to _EA 1955 s.60A(4)(a) with the Employment (Limitation of Overtime Work) Regulations 1980
reg.2_. Enforced in `payroll_runs/lib/validate.ts` as `OVERTIME_LIMIT_EXCEEDED`, a warning rather
than a blocker because `on_exceed` says `WARN`.

The 12-hour daily boundary is enforced too, but it is **not** an `overtime_limits` row: it is read
from `pay_components.definition.after_total_work_hours` on `OVERTIME_EXCESS` components and raises
`DAILY_WORK_LIMIT_EXCEEDED`. The decomposition report records this as deliberate — `on_exceed` has
only `WARN | BLOCK` and no `RECLASSIFY`, which is what a daily excess actually does.

### The RM4,000 test and the manual/non-manual distinction

`payroll_runs/lib/measure.ts` decides statutory OT/rest-day/holiday coverage:

```ts
export function isStatutoryOvertimePayCovered(options: {
	readonly jurisdictionCode: string;
	readonly monthlyBaseSalary: number;
	readonly statutoryWorkCategory: string | null;
}): boolean {
	if (options.jurisdictionCode !== 'MY') return false;
	return (
		options.monthlyBaseSalary <= 4000 ||
		(options.statutoryWorkCategory != null && options.statutoryWorkCategory !== 'NON_MANUAL')
	);
}
```

The classification it reads is a real, editable column —
`employment_terms.statutory_work_category`, an enum of `NON_MANUAL`, `MANUAL_LABOUR`,
`MANUAL_LABOUR_SUPERVISOR`, `COMMERCIAL_VEHICLE_OPERATOR`, `VESSEL_WORK`, defaulting to
`NON_MANUAL`, whose own doc comment names the RM4,000 exclusion. `overtime_eligible` on the same
row is a per-employment contractual override that can only widen coverage. The rule is also stated
in prose in [Time, overtime and cutoffs](time-overtime-and-cutoffs.md#coverage), and three cases in
`scripts/verify-payroll-arithmetic.mjs` pin the boundary as inclusive (RM4,000 exactly is covered).

## Not encoded

- **No statutory rest or meal break rule exists anywhere.** `shift_definitions.break_minutes`,
  `shift_definitions.overtime_break_minutes` and `time_entries.break_minutes` are flat _durations_
  deducted from measured hours. They carry no window and no placement, so nothing in the workspace
  can express or check a rule of the form "a break of at least N minutes after M consecutive hours".
  `payroll_runs/lib/overtime.ts` states the limitation directly: the schema records a flat
  `break_minutes` rather than break windows.
- **No daily or weekly `overtime_limits` row** for Malaysia — or for any jurisdiction. The
  `DAY | WEEK | MONTH` enum exists; only `MONTH` is ever populated.
- **No wage threshold anywhere in the data model.** `overtime_rules` and `overtime_limits` are
  jurisdiction-wide and unconditional: there is no way to say "this ladder applies only to
  employees satisfying X". `overtime_band` measures hours or fractions of a day only;
  `overtime_award` is a bare kind plus multiple. `jurisdictions` has no wage-threshold column. Every
  `4000` in the statutory seed is EPF or spouse relief, and every "First Schedule" is the EPF Act
  1991 or PSMB Act 2001 schedule — none touches overtime.
- **`eligibility_rules` cannot express the test.** Its predicates are `EMPLOYMENT_TYPE`,
  `WORK_CLASSIFICATION`, `SERVICE_MONTHS`, `GENDER`, `DEPARTMENT`, `PAYROLL_GROUP` — no salary or
  wage predicate. It also reads `work_classification` (`EA_COVERED | NON_EA | MANAGERIAL`), not
  `statutory_work_category` (`NON_MANUAL | MANUAL_LABOUR | …`); the two vocabularies are not 1:1.
  The decomposition report records the consequence in as many words: the EA First Schedule RM4,000
  test cannot be expressed, marked _not expressible_.
- **No UI surface** for `overtime_rules` or `overtime_limits` — neither collection has a
  `+representation.svelte`, so nothing on screen shows an operator which ladder priced a run.

### The shape of the gap

The RM4,000 test is applied, but not as data. That means it is:

- **Not effective-dated.** Every other statutory value carries an `effective_range`; a First
  Schedule amendment would need a code change and a release, and would silently re-price historical
  runs rather than applying from its own commencement date.
- **Not cited.** Every overtime rate row names its section in `authority`. This one names no section
  anywhere in code, seed or docs — only the phrase "First Schedule".
- **Not portable.** `if (jurisdictionCode !== 'MY') return false` means the function answers _"not
  covered"_ for every non-Malaysian jurisdiction, so any future jurisdiction with its own coverage
  test inherits a wrong answer rather than an absent one.
- **Not visible.** It is not in the configuration snapshot captured on a run, so a paid run does not
  record which coverage threshold priced it.

## Needs a legal source before anything is written

Nothing below should be added to seed, model or docs until the user supplies the authority. Each is
a question this repository cannot answer from its own contents.

1. **The current First Schedule wage ceiling and its commencement date.** RM4,000 is what the code
   applies; the repository nowhere cites the instrument or the date it took effect, and the
   Employment (Amendment) Act 2022 changed First Schedule scope. Required: the paragraph of the
   First Schedule, the amending instrument, and the date the figure commenced.
2. **The precise category list.** The five values in `statutory_work_category` are described in
   the model as _inferred_. Required: the First Schedule paragraphs each corresponds to.
3. **Whether the threshold is inclusive.** Code treats exactly RM4,000 as covered. Required: the
   statutory wording ("exceeding" vs "not less than").
4. **What "wages" means for the test.** Code compares `base_salary`. Required: whether the First
   Schedule test is on basic wages or on wages as defined in s.2, which would change the comparand.
5. **The rest-break rule**, if one is to be encoded at all — the duration, the number of consecutive
   hours that triggers it, and whether it is paid.
6. **Whether a daily overtime cap exists** as a statutory limit distinct from the 12-hour spread the
   engine already warns on.

## The model shape a wage ceiling would need, _if_ the authority is supplied

Sketch only — not implemented, and not to be implemented before item 1 above is answered.

The natural home is a new effective-dated collection rather than a field on `overtime_rules`,
because the test governs _who is entitled to the whole ladder_, not how any single band is priced.
Putting it on `overtime_rules` would mean repeating the same threshold on all six MY rows, and
would have to be added to the `overtime_rules_no_overlap` exclusion constraint — two rules differing
only by wage band would otherwise collide with a `23P01`.

```text
overtime_coverage_rules
  jurisdiction_id   uuid       notNull
  wage_ceiling      money      nullable   -- null = no ceiling; the entitlement is universal
  wage_basis        enum       notNull    -- which wage figure the ceiling compares against
  ceiling_is_inclusive boolean notNull    -- whether the ceiling amount itself is covered
  exempt_categories text[]     notNull    -- categories covered regardless of the ceiling
  authority         text       notNull    -- section + instrument, as every other statutory row
  effective_range   dateRange  notNull
```

`isStatutoryOvertimePayCovered` would then read this row instead of its literals, return `true`
where no row exists (absence of a coverage restriction is universal coverage, which also fixes the
non-MY `false`), and the resolved row would join the run's configuration snapshot so a paid run
records the ceiling that priced it. `statutory_work_category` needs no change — it is already the
right column, and `exempt_categories` names its values.

Two things this shape does _not_ solve, and should not pretend to: `eligibility_rules` still cannot
see `statutory_work_category`, and no break-window model exists to hang a rest-break rule on.
