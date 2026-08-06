# Statutory overtime coverage: what is encoded, and what is not

Began as a survey of what the repository contained, prompted by the question _"check statutory law
for OT and break time — manual labour vs non-manual, RM4,000 minimum"_. The survey found the
Malaysian First Schedule scope test applied as a **hard-coded literal in engine code** rather than
as effective-dated, cited data, and listed the legal questions the repository could not answer from
its own contents.

Those questions have since been researched against source and the test has been moved into data.
This document now records both: the model, and the sources each value came from with the tier of
each. **No rate, threshold, category mapping or break figure here was written from memory.** Where
the sources did not settle something, the shape is encoded and the value left absent — those are
listed under [Still not encoded](#still-not-encoded), not quietly defaulted.

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

### Overtime and hours caps — two rows

`MY_OVERTIME_LIMITS` holds two, and they count different things — see `measures`:

| Period  | `measures`         | Max | Cited authority                                                                 |
| ------- | ------------------ | --- | ------------------------------------------------------------------------------- |
| `MONTH` | `OVERTIME_HOURS`   | 104 | EA 1955 s.60A(4)(a) with the Limitation of Overtime Work Regulations 1980 reg.2 |
| `DAY`   | `TOTAL_WORK_HOURS` | 12  | EA 1955 s.60A(7), with s.60C(2) for shift work                                  |

The monthly row is enforced in `payroll_runs/lib/validate.ts` as `OVERTIME_LIMIT_EXCEEDED`; the
daily row as `DAILY_WORK_LIMIT_EXCEEDED`.

`on_exceed` no longer decides whether the run completes. Both `WARN` and `BLOCK` stop it, because a
run has no degraded state: an issue the operator was not forced to read was an issue nobody read —
the engine returned these and the create hook discarded them. The column still records what the
authority says, and the refusal quotes it; it does not decide who finds out.

Separately, `pay_components.definition.after_total_work_hours` on `OVERTIME_EXCESS` components
decides where a day's value is **reclassified**. That stays a pay-component concern rather than an
`overtime_limits` row, because `on_exceed` offers only `WARN | BLOCK` and no `RECLASSIFY` — moving
value between components is not the same act as refusing the run, and the two now happen for
separate reasons: the component reclassifies, the limit refuses.

### Coverage — `overtime_coverage_rules`, three rows

Seeded in Core alongside the ladders. One effective-dated, cited row per jurisdiction decides
**who** the ladder applies to, as distinct from what an hour is worth.

| Column                                  | Meaning                                                                |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `wage_ceiling` (money, nullable)        | Null is a stated fact: no wage-based restriction exists                |
| `ceiling_is_inclusive` (bool, nullable) | `true` for "exceeds X", `false` for "not less than X"                  |
| `wage_basis` (enum, nullable)           | `STATUTORY_WAGES` or `BASE_SALARY` — which figure the ceiling measures |
| `category_basis` (enum)                 | Which employment column the two arrays name values from                |
| `exempt_categories` (text[])            | Covered whatever the wage                                              |
| `excluded_categories` (text[])          | Never covered, whatever the wage                                       |
| `authority`, `effective_range`          | As every other statutory row                                           |

`decideOvertimeCoverage` in `payroll_runs/lib/coverage.ts` reads a resolved row and returns
`COVERED`, `NOT_COVERED` or `UNDETERMINED`. Order is exclusion, then exemption, then the ceiling: a
statute that disapplies a whole Part to a class of worker outranks a wage test, and a category
written "irrespective of the amount of wages he earns" outranks it too. **No row means covered.**

### Breaks — `rest_break_rules`, four rows

`after_consecutive_hours` (nullable), `minimum_minutes`, `counts_as_worked_time` (nullable),
`applies_when`, plus authority and effective range. The window is the field the flat
`break_minutes` columns cannot supply: those record how long a break was, never when it was owed.

The run picks these rows with the rest of its law — `pickConfiguration` resolves them by
jurisdiction and effective date, and the resolved set joins the configuration snapshot, so a run
can say which break rules governed it. **Nothing enforces them yet**: whether a break was actually
taken is a question over punches (`time_entries`, `shift_definitions`), which payroll does not
answer. The rows are law made addressable, and the figures a future check will quote are already
the statute's, not a literal waiting to be copied.

### The wage comparand — derived, not substituted

The ceiling is only as good as the figure it is compared against. First Schedule para 3 defines
"wages" for the Schedule as s.2 wages — basic wages **and all other cash payments for work done** —
less commissions, subsistence allowance and overtime payment. The engine derives that figure per
employment in `measure.ts`, from the pay component model:

| Component as modelled                             | Read as                                |
| ------------------------------------------------- | -------------------------------------- |
| `definition.source = SCHEDULE`                    | basic wages (from `employment_terms`)  |
| `policy.kind = EARNING`, any other source         | another cash payment for work done     |
| `definition.source = OVERTIME`, `OVERTIME_EXCESS` | overtime payment — para 3 takes it out |
| every other kind                                  | not wages                              |

The amounts are the signed entry totals settling in the run for each component the employment is
eligible for — the contractual monthly figures, not prorated amounts, because para 1A asks what a
person's wages _are_ a month. `classifyWageComparand` and `deriveStatutoryWages` in
`payroll_runs/lib/coverage.ts` carry the classification; a rule naming `STATUTORY_WAGES` is
answered from the derived figure and a rule naming `BASE_SALARY` from base salary, and never the
other way around.

Two para 3 exclusions the component model cannot express, recorded here rather than guessed:
**commissions and subsistence allowance have no category of their own** — nothing on
`pay_components.policy` or `pay_components.definition` distinguishes them from any other earning,
so an earning of either kind is counted in the comparand. The seeded catalogues contain no such
component, so no shipped population is affected; a company adding one must know the comparand will
overstate until the model carries the distinction. `FORMULA` earnings are likewise not counted —
their amounts exist only once the component walk has run, which the coverage decision precedes —
and the under-inclusion keeps an employee inside the ladder rather than outside it.

## The sources, and how far each was trusted

Primary text was read wherever it could be reached. Where only a secondary reproduction was
available, the tier is named rather than smoothed over.

| Fact                                                                                                                          | Source                                                                                     | Tier                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------ |
| First Schedule paras 1, 1A, 2, 3 as substituted; P.U. (A) 262; gazetted 15 Aug 2022                                           | Malaysian Employers Federation circular AG 16/2022, reproducing the Order's table verbatim | Secondary, verbatim reproduction     |
| s.60A(1)(a)–(d), provisos (i)–(iii), s.60A(3), s.60A(4)(a); Part XII heading and contents; s.2 "wages"; First Schedule para 3 | Laws of Malaysia reprint, Act 265                                                          | Primary                              |
| "forty-eight" → "forty-five" in s.60A(1); s.60A(1)(a) unamended                                                               | Laws of Malaysia, Act A1651 s.20 (gazette print)                                           | Primary                              |
| 104 overtime hours in any one month                                                                                           | Employment (Limitation of Overtime Work) Regulations 1980 reg.2, JTKSM/MOHR published copy | Primary                              |
| Commencement deferred from 1 Sep 2022 to 1 Jan 2023                                                                           | Consistent across several law-firm publications; **no instrument was located**             | Secondary, uncorroborated by gazette |
| Labor Code arts. 82, 83, 85, 87                                                                                               | LawPhil reproduction of P.D. 442                                                           | Secondary, verbatim reproduction     |
| Meal period shortened to 20 min is compensable                                                                                | Omnibus Rules Book III Rule I s.7, via secondary summaries only                            | Secondary, not relied on             |
| PP 35/2021 Pasal 26, 27, 29                                                                                                   | JDIH Kemnaker published PDF                                                                | Primary                              |
| UU 13/2003 Pasal 79(2)(a) as amended                                                                                          | UU 6/2023 Bab IV text                                                                      | Primary                              |

Two things the sources did **not** settle, and which are therefore encoded as absent:

- **Whether the Malaysian break is paid.** s.60A(1)(a) calls it "a period of leisure" and is silent
  on wages. The continuous-attendance proviso says the eight hours are "inclusive of" the meal
  periods, which settles how hours are counted, not how they are paid.
  `counts_as_worked_time` is null on both Malaysian rows.
- **Whether the Philippine hour is paid.** Only an implication from the Omnibus Rules' treatment of
  a _shortened_ meal period was found, and an implication is not the article's words.

## What changed, and what it fixes

Every defect the survey named is closed:

- **Effective-dated.** An amendment is a new row with its own range; history keeps repricing under
  the rule that was in force.
- **Cited.** Every row names its instrument, its paragraph and, for Malaysia, its commencement.
- **Portable.** `if (jurisdictionCode !== 'MY') return false` is gone. The Philippines and Indonesia
  carry their own cited rows; Singapore, Vietnam and Taiwan carry none and are therefore treated as
  covering everyone.
- **Visible.** Two new tabs on the jurisdiction record, and the resolved row joins the run's
  configuration snapshot, so a PAID run records the ceiling that priced it.

Two defects the survey did **not** catch were found while reading the sources:

1. **`VESSEL_WORK` was answered backwards.** The old test read
   `statutoryWorkCategory !== 'NON_MANUAL'` and so treated vessel workers as _covered_. First
   Schedule para 2(4) disapplies **Part XII** to them, and Part XII of Act 265 is "Rest days, hours
   of work, holidays and other conditions of service" — ss.58A, 59, 60, 60A, 60B, 60C, 60D, 60E,
   60F and 60I. They are outside the entire ladder at any wage. They are now `excluded_categories`.
2. **The comparand was wrong, and is now derived.** The code compared `base_salary`. First
   Schedule paragraph 3 defines "wages" for the Schedule as s.2 wages — basic wages _and all other
   cash payments for work done_ — less commissions, subsistence allowance and overtime payment.
   That is wider than basic pay, so a person on RM3,800 basic plus a RM500 fixed allowance is
   outside the ladder while the old test put them inside it. The engine now derives the para 3
   figure from the pay components and their entries — see
   [The wage comparand](#the-wage-comparand--derived-not-substituted) — with the two exclusions
   the model cannot express recorded there rather than guessed.

The RM4,000 boundary itself was **corroborated and is correct**: para 1A bites on wages that
"exceeds four thousand ringgit a month", so RM4,000 exactly remains covered, as the engine assumed.

### The daily hours cap — a literal that turned out to be citable

`engine.ts` carried `maxWorkHours: 12` inline, applied to **every** jurisdiction in the workspace,
which meant a Malaysian statute governed Indonesian and Philippine runs. Reading the source settled
it: **Employment Act 1955 s.60A(7)**, with **s.60C(2)** for shift work — "no employer shall require
any employee under any circumstances to work for more than twelve hours in any one day", except in
the s.60A(2)(a)–(e) circumstances. It is a real statutory cap, so it moved into data.

It could not go into `overtime_limits` as it stood. That collection's `max_hours` meant _overtime_
hours — 104 a month — and this 12 counts **all** hours worked. The Core decomposition report had
already refused a total-hours cap for Singapore on exactly that ground. So `overtime_limits` gained
`measures: OVERTIME_HOURS | TOTAL_WORK_HOURS`, every existing row states which it is, and the two
consumers each read only their own kind. Read the wrong way, a 12 meant as total hours becomes a
licence for twelve hours of overtime on top of a full shift.

A jurisdiction that states no daily limit now has none enforced, rather than inheriting Malaysia's.

## Still not encoded

- **Commissions and subsistence allowance have no component category.** Para 3 takes them out of
  the comparand, and `pay_components` carries nothing that distinguishes them from any other
  earning — the derivation therefore counts an earning of either kind, overstating the comparand
  for a company that pays them. The seeded catalogues contain no such component. Closing the gap
  needs a wage-class distinction on the pay component model itself.
- **`FORMULA` earnings are not in the comparand.** Their amounts exist only once the component
  walk has run, and the coverage decision precedes it — an ordering the walk's formula
  dependencies impose. The under-inclusion keeps an employee inside the ladder rather than
  outside it; no seeded company carries a formula earning that a coverage ceiling tests.
- **The Philippine art.82 exclusions, except managerial.** Field personnel, workers paid by results,
  family members, domestic helpers and persons in personal service have no member in
  `statutory_work_category` or `work_classification`. Recorded in Core as
  `PH_OVERTIME_COVERAGE_CATEGORIES_UNMODELLED`; those employees are treated as covered.
- **Indonesia's `golongan jabatan tertentu`.** PP 35/2021 Pasal 27(3) is broader than `MANAGERIAL`,
  and Pasal 27(4)–(5) make the exemption conditional on the group being written into the contract,
  company regulations or collective agreement — a fact this workspace does not record. Nothing is
  emitted; see `ID_OVERTIME_COVERAGE_CATEGORIES_UNMODELLED`.
- **Singapore, Vietnam and Taiwan** were not researched. Each now covers everyone. For Singapore
  that is **known to be wrong** — Employment Act Part IV, which carries the overtime entitlement,
  applies only below a salary threshold. Listed in `OVERTIME_COVERAGE_UNRESEARCHED`.
- **s.60A(1)(b)–(d) hours limits** — eight a day, a ten-hour spread, forty-five a week. Recorded in
  `MY_HOURS_OF_WORK_LIMITS_UNMODELLED`. These bound _normal_ hours and the shape of a working week;
  `overtime_limits` bounds a quantity a run measures, and none of the three is that.
- **PP 35/2021 Pasal 26 hour caps** (4/day, 18/week) and **Pasal 29 meal provision** (1,400 kcal
  where overtime runs four hours or more, not commutable to money). Recorded in Core, not emitted:
  the Indonesian ladder is empty by an earlier decision, so there is no measured quantity to cap,
  and a calorie floor on provisions is not a rest period with a duration.
- **`eligibility_rules` still cannot express any of this.** Its predicates carry no wage term and it
  reads `work_classification`, not `statutory_work_category`.
- **Nothing enforces `rest_break_rules`.** The rows are picked and snapshotted with the run's
  configuration, but whether a break was taken is measured from clock data, which is `time_entries`
  and `shift_definitions` work.
