# Refactor findings — where the plan, the law and the working payroll disagree

Produced while implementing `plan/`. Every claim here is anchored to either a `file:line` in the
pre-refactor engine or a reconciled figure from the customer's own workbook (employee `NHPMY0053`,
2026-01, cent-exact across EPF, SOCSO, EIS, HRDF, NPL and net pay).

The plan is a good architecture document. It is **not** implementation-complete, and in four places it
is arithmetically wrong. Nothing below was silently absorbed.

---

## The oracle

**The oracle is the workbook, not the pre-refactor code.**

The workbook is produced by Infotech, the customer's HR system, which derives overtime and statutory
amounts from base salary and the employee profile. It is a real payroll implementation, so matching it
_is_ the compliance test — it already encodes the statute. The pre-refactor engine was our
approximation of it, written quickly, and where the two disagree the engine is the thing that is wrong.

This matters because the two readings pull apart in practice. Rest-day overtime is the clearest case:
the old engine paid every clocked hour at a flat hourly multiple and classified the result as
EPF-exempt overtime. The Act bands the same day as fractions of a day's wages. That divergence is 210
`derived-ot-policy` accounted differences — differences _from the workbook_, which says the old engine
was the outlier.

**Not yet proven, and the reconciliation will settle it.** The workbook reports `overtime` as a single
aggregated figure per employee, so it cannot be read off directly which reading Infotech used. The
inference is that a real payroll system applies EA s.60(3), and that the 210 differences are the old
engine departing from it. If moving to the banded reading _increases_ the difference count instead of
reducing it, that inference is wrong and the flat reading should come back — as data, by removing the
`FROM_START_OF_DAY` rows.

### The one place the workbook is known to be wrong

**Incentive overtime.** Infotech computes it up front, by hand, and inconsistently. That part is not to
be replicated. In this system the rule is mechanical and derived on every run:

> the daily excess over the statutory overtime ceiling pipes into an incentive component,
> at the same multiplier rates, automatically.

Nothing about it is seeded, configured per employee, or entered by anyone. It falls out of the clocks.
The 92 `incentive-ot-no-attendance-rule` differences are irreducible for exactly this reason:
reproducing them would mean seeding calculated values, which is excluded by policy.

### Seeded versus derived

The distinction the whole design rests on. **Seeded** is what happened: base salary, the employee
profile, clocks, rosters, leave, claims, loans, and the catalogue and law that govern them.
**Derived** is every number that follows: overtime hours and money, incentive overtime, contribution
bases and amounts, gross, deductions, net, employer cost, and every leave balance.

No calculated value is ever seeded. Verified: `component_entries` carries only `CLAIM`, `INSTALMENT`,
`ONE_OFF` and `STANDING` origins — no overtime, no statutory amounts — and `payroll_runs`, `payslips`,
`payslip_lines` and `payslip_contributions` are not seeded at all. The overtime and incentive
components exist in the catalogue as _definitions_; their values come from the clocks on every run.

Two consequences run through everything below:

- **Legal obligations get implemented, not dropped.** Infotech applies them, so the workbook reflects
  them; a rule the model cannot express is a model to fix, not a gap to record.
- **Rules are data.** A ladder, band, rate or entitlement lives in a row and changes by editing that
  row. Where this document mentions a constant in the engine, that is a defect being called out.

The one place the workbook legitimately wins over the Act's plain reading is the **attendance window**
(§A1): which days a run covers is an administrative convention, not a legal question.

---

## A. Decisions that change money — resolve these first

### A1. The attendance window is off by one day ★ highest impact

|                               | window for the January run, cutoff day 21                                       |
| ----------------------------- | ------------------------------------------------------------------------------- |
| legacy (`periods.ts:163-169`) | `start = monthDay(m−1, 21)`, `end = monthDay(m, 21) − 1` → **[21 Dec, 20 Jan]** |
| plan ch. 05                   | **[22 Dec, 21 Jan]**                                                            |

Both are honest readings of "cutoff day 21" — _the last day included_ versus _the first day of the new
window_. But every 21st-of-month time entry and leave allocation lands in a different run, which
cascades through overtime → gross → every statutory band → PCB.

**Estimated impact: all 1,632 accepted baseline differences, and more.** This is the `npl-21st-cutoff`
category. Resolve before anything else; everything downstream inherits it.

**Implemented:** legacy. It reconciles against the workbook; the plan's reading does not.

### A2. PCB `PROGRESSIVE` is cumulative, not a flat addend

`applyProgressive` (`packages/std/src/reckon/ops.ts:355-393`) computes
`base + (value − previousMax) × rate`.

Every one of the 10 Malaysian band `base` values reconciles exactly as _accumulated tax on preceding
bands, less the RM400 (Cat 1) / RM800 (Cat 2) s.6D rebate below RM35,000_:

```
−250    = 15,000 × 1%  − 400
600     = 150 + 450
528,400 = 136,400 + 1,400,000 × 0.28
```

At chargeable income 44,111.40 the plan's reading `0.06 × 44,111.40 + 600` gives **3,246.68**; the
correct answer is **1,146.68**. The plan's own stated figure, **1,165.73**, matches neither — it was
reverse-engineered from the monthly spread and must never become a test fixture.

**Hypothesis:** the plan's table was written from the _shape_ of a tax-scale row (`rate`, `constant`)
without executing it.

**Implemented:** cumulative.

### A3. Rest-day and public-holiday overtime — an HR decision, not an engineering one

|                                           | 8 hours worked on a rest day                                |
| ----------------------------------------- | ----------------------------------------------------------- |
| legacy (`overtime-derivation.ts:177-202`) | `hours × 2.0 × ORP` on every hour → **169.28**              |
| plan ch. 06                               | EA-banded `DAY_WAGE_MULTIPLE` — one day's wages → **84.62** |

Worse, the plan routes the result to `VARIABLE_ALLOWANCE`, which is **EPF-liable**, where overtime is
**EPF-exempt** (EPF Act 1991 s.2). So the divergence is not only ~RM88 per rest day per employee — it
changes statutory liability.

The EA-banded expressions already exist in the statutory profile (`MY-2026-01.ts:394-396`) as
**info-only outputs that nothing reads**. Someone modelled the statutory version and never wired it up;
the customer's actual practice is the simpler, more generous flat rule.

**Estimated impact:** the 210 `derived-ot-policy` entries plus most of the 1,080 `downstream` ones.

**DECIDED — the banded reading.** Work up to the normal day pays a day's wages and only the hours past
it enter the hourly ladder. Chosen because Infotech, which produced the workbook, is a real payroll
system applying EA s.60(3) — so this should move _toward_ the oracle, not away from it. The
reconciliation is the proof; see "The oracle" above for what to do if it does not.

There is deliberately **no switch**. Whether a day's wages is payable is not a setting — it is whether
the jurisdiction _states_ a `FROM_START_OF_DAY` band for that day type. Malaysia does; Singapore states
a single open hourly band and so pays none. Granting or removing the entitlement is an `overtime_rules`
row, never a code change.

Seven assertions in `scripts/verify-payroll-arithmetic.mjs` lock this in — that a day's wages is paid
once and at the highest band entered, that no hour inside the normal day reaches the hourly ladder, and
that a jurisdiction stating no day-wage band pays every hour hourly. The flat reading cannot return by
accident.

The expectation is that this _reduces_ differences against the workbook. If it does not, the inference
was wrong — say so and revert by deleting the `FROM_START_OF_DAY` rows, not by editing the engine.

### A4. SOCSO / EIS are table lookups selected by band _ceiling_

The published PERKESO amounts are seeded verbatim and selected by `wage <= band_to`
(`ops.ts:71-81`). They are **not** reproducible from any rate applied to the actual wage, nor from a
band midpoint: `81.375 → 81.35` but `83.125 → 83.15`.

The plan's worked example (`4,788.45 → 23.25 / 81.35`) quotes the wrong row — 23.25 belongs to the
RM4,700 band; 4,788.45 lands in `max: 4,800` → **23.75 / 83.15**.

**Anyone "fixing" the table to satisfy the plan's example shifts every employee one band.**

---

## B. Things the plan removed that the payroll needs

### B1. Six overtime inputs (chapter 06 is under-modelled)

Chapter 06 models a time entry as `clock_in · clock_out · break_minutes · state`. The working engine
reads six more facts. Implementing chapter 06 literally would pay overtime **on unauthorised days, on
no-overtime shifts, through unpaid breaks, and beyond the statutory 4 h/day ceiling that makes it
lawful** — i.e. not merely different, but _less correct_ than what it replaces.

| restored                                           | why                                                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `time_entries.overtime_authorized`                 | a clock overrun on an unauthorised day earns nothing. Distinct from the approval stamp: a record can be valid _and_ unauthorised for overtime. 2,607 Nihon days |
| `time_entries.overtime_in` / `overtime_out`        | the Philippines records overtime as a **separate punch**; regular-clock overrun earns nothing. 217 OPSPH days                                                   |
| `shift_definitions.pays_overtime`                  | fixed office shifts never pay overtime                                                                                                                          |
| `shift_definitions.overtime_break_minutes`         | unpaid rest break between shift end and overtime start                                                                                                          |
| `roster_entries.designation` (`WORK`/`REST`/`OFF`) | the plan collapsed three day types into two. An **OFF** day pays every clocked hour but at the **ORDINARY** multiplier — behaviourally distinct from both       |
| `component_definition` `OVERTIME_EXCESS` arm       | see B2                                                                                                                                                          |

Two of these — `designation` and `pays_overtime` — **already existed in the committed migration
history**. The plan dropped columns that had shipped.

### B2. Incentive overtime had no home in the model

Malaysia caps overtime at 4 h/day (EA 1955 + Limitation of Overtime Work Regulations 1980). Beyond
that it is not payable _as overtime_, so the engine **reclassifies** the excess: same money, different
component type, therefore a different EPF treatment.

The plan could not express this. `overtime_limits.on_exceed` is `WARN | BLOCK` — neither reclassifies;
`definition.OVERTIME` is `{rule, minimum}` with no overflow target; and the partial unique index
permits exactly one component per rule.

**Resolution:** the split happens **upstream, in the measurement layer** — one clock becomes capped
`overtime_entries` plus `incentive_overtime_entries` (`units = excess × multiplier`, valued at
ordinary hourly). The overflow is a separate measured quantity, not a second `OVERTIME`-source
component, so the unique index is never contended. The target is a new `OVERTIME_EXCESS` arm on
`component_definition` — placed on the _company_ side, because putting it on `overtime_limits` would
make a JURISDICTION row point down at a COMPANY component and break the one-way wall of ch. 01 §1.

**92 baseline entries** (`incentive-ot-no-attendance-rule`).

### B3. Payslip provenance was deleted with no replacement

The plan gave `payslip_lines` a single nullable `source_entry_id → component_entries`. That is wrong
twice: an overtime line consumes **many** time entries, and a line may consume leave requests instead.
The three legacy link tables were removed and nothing replaced them, yet the e2e asserts non-empty
consumed **Time entries** for three named employees.

**Resolution:** one `payslip_line_sources` link collection with a `source` variant
(`COMPONENT_ENTRY` / `TIME_ENTRY` / `LEAVE_REQUEST`) — rather than three nullable FKs, which ch. 01 §3
forbids.

### B4. Corrections use adjustment entries

A `PAID` run is immutable and has no payroll-specific revision form. A post-payment correction is an
adjustment entry, with its reason and approval history carried by the platform's standard mutation
protocol, and is consumed by a later `DRAFT` run.

### B5. Other capability losses

- `companies.pay_cutoff_day`/`pay_day` express **monthly cadence only**. Legacy supported semi-monthly
  and weekly schedules. Nihon and OPSPH are both monthly, so the e2e still passes.
- `payroll_runs` lost the `LOCKED` / `EXPORTED` lifecycle states.
- Restored for the e2e: `component_entries.description` (the `CLAIM` origin arm has no free text).

---

## C. Things the new model genuinely cannot express

Found while decomposing the CEL rule bundles into structured rows.

| gap                                                  | consequence                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| EPF non-citizen 2%/2%                                | no residency selector on `rate_selector`                           |
| PCB Category 2 (married)                             | no marital selector — **RM400/yr over-withholding**                |
| PCB reliefs, caps, zakat                             | `relief_for` is a bare uuid array; it cannot carry a cap or a rule |
| PCB truncate-then-up-5-cents                         | not in the `rounding` enum                                         |
| Malaysia's RM4,000 overtime-eligibility threshold    | `eligibility_rules` has no salary rule                             |
| PH night-shift differential, special non-working day | no component type or measure for either                            |
| `WAGE_BASE` vs `NET` deduction basis                 | the old axis is orthogonal to the type grid and collapses lossily  |

### C2. Further gaps found decomposing Singapore, Vietnam and Taiwan

Two of these need sign-off, because they change contribution amounts:

- **VN/TW `benefitTaxability` si/hi/li/nhi flags were dead data — DECIDED: vestige, deleted.** Every
  contribution base in those bundles was `proratedSalary` or `applyTier(proratedSalary)`, so the flags
  never fired. The grid follows _behaviour_, as it does for the Philippines. The flags themselves went
  with the CEL bundles; what survives is a comment on each affected cell recording why it was decided
  that way. No contribution amount changes.
- **Taiwan overtime is the one place the emitted rows deliberately differ from the CEL.** The bundle
  flattens LSA art. 24 to `1.34` / `1.67` and drops rest-day work entirely; the decomposition emits the
  real progressive ladder (exact 4/3 and 5/3) and adds rest-day work. The CEL values are preserved in
  an addendum.
- **Vietnam rest-day overtime (2.0×, art. 98(1)(b)) is new money** — the CEL silently discarded those
  hours.

Structural gaps with no representation: SG CPF's (500, 750] phasing band carries **two payers with two
different functional forms** (employee affine, employer percentage) where `rate_award` holds one shape;
CPF's split rounding and Additional Wage ceiling (needs a year-to-date axis — also absent from the CEL);
`overtime_limits` has no `YEAR` period, so VN's 200/300-hour annual caps and TW's per-quarter proviso are
unrepresentable; no time-of-day axis, so VN night premiums are lost; `accrual_key` is a point rather than
a range, truncating VN's unbounded `12 + floor(years/5)` ladder at 40 years;
`leave_year_start_month` is an integer and cannot hold Singapore's actual `SERVICE_ANNIVERSARY`.

Fixture-level losses with no column anywhere: `timezone`, the `MY-SEMENANJUNG` sub-national code,
business-day adjustment on pay schedules, `tax_residency` and `socso.contribution_category` — the last
two are load-bearing for Malaysian statutory reporting.

**And the largest structural risk: the treatment grid is entirely new.** Legacy has no grid — it uses
per-component eligibility records plus named base expressions, and it already produces cent-exact
numbers with one fewer dimension. The grid is the centrepiece of this refactor and it is **unproven
against parity**. Only the e2e can answer whether it reproduces the existing figures.

---

## D. Errors in the plan's own SQL and arithmetic

1. **Chapter 02 §7's exclusion-constraint SQL does not run.** `(effective_range->>'start')::date` is
   **STABLE**, not IMMUTABLE (`pg_proc.provolatile` for `date_in` is `s`), and Postgres refuses a
   non-immutable function in an index or `EXCLUDE` expression. Fixed with an IMMUTABLE
   `norbital_daterange(jsonb) → daterange` helper. `::numeric` _is_ immutable (`numeric_in → i`), so
   numeric band ranges are fine inline.
2. **Three exclusion element lists are too narrow.** Taken literally they reject configurations this
   payroll actually has — EPF/SOCSO/EIS age bands legitimately share wage bands; a rest day carries
   both a `FROM_START_OF_DAY` day-wage rule and a `BEYOND_NORMAL` hourly rule; and
   `numrange(band_from, NULL)` makes every service band overlap every higher one. Each needed extra
   dimensions (`selector->>'by'`, `band->>'measure'`, `key->>'by'`, a point range for service bands).
3. **Chapter 02 says "26 models"; its five sections enumerate 27.**
4. **The EPF terminal-band doctrine is wrong.** "A ceiling is the terminal band" (§A.3) holds for
   SOCSO. EPF has no ceiling — it has a _step that vanishes_ above RM20,000, above which it is exact
   `wage × percent`. Seeding a FIXED terminal band would freeze EPF for every high earner.

---

## C3. Gaps found while building the engine

- **Claim cap ceilings cannot be enforced.** `component_definition`'s cap carries
  `matrix: string`, naming a band table — **but no collection in the 28 holds cap amounts.**
  `reimbursement_percentage` works and consumption is derivable, but `on_exceed: BLOCK` has nothing to
  test against. Needs either a cap-amount collection or a numeric cap field.
- **Correction runs are absent.** `payroll_runs` is unique on `(company_id, period)` and has no
  `corrects_run_id`, so the legacy delta-correction path (§B4) has no home. Four baseline entries need
  it.
- **Statutory machinery had nowhere to live**, so it is expressed as a closed token set on
  `statutory_contributions.special_rules` (`BRACKET_STEP`, `PERSONAL_RELIEF`, `SPOUSE_RELIEF`,
  `CHILD_RELIEF`, `RELIEF_CAP`, `RELIEF_POOL`, `RELIEF_PROJECTED`, `MIN_WITHHOLD`, `ROUND`,
  `ADDITIONAL_REMUNERATION`). The alternative was hard-coding EPF bracketing and PCB's 9,000 / 4,000 /
  350 reliefs in the engine: `statutory_contributions.rounding` cannot even express `UP_5_CENTS`, and
  no table holds a relief amount. An unknown token throws rather than being ignored.
- **Break handling lost resolution.** Legacy subtracted _overlapping break windows_; the rebuilt
  `shift_definitions` carries only a flat `break_minutes`. The `shift_breaks` custom type still exists
  but no model uses it. Sub-hour divergence is possible on night shifts.
- **No exempt-earning type**, so `exemptBenefits` is always 0 — a non-wage payment is a
  `REIMBURSEMENT`.
- **No timezone column anywhere.** A shift start is wall-clock and a punch is an instant, so pairing
  them needs an offset. The seed writes `+08:00` instants; left at UTC the engine would anchor each
  work date to UTC midnight and throw the early-clock-in clamp and shift-end comparison out by **eight
  hours**, silently mispricing every overtime hour. Now stated as a constant, as legacy also did — but
  a third jurisdiction off UTC+8 needs a real column, not a constant.
- **No test runner in the workspace** (no `vitest`, no `test` script), so the 72 arithmetic assertions
  are a runnable script: `node scripts/verify-payroll-arithmetic.mjs`.

---

## C4. Two failures a schema replacement causes that nothing catches

Both were found only by running the thing end to end. Neither produces a compile error, a seed error,
or any log line.

### Access policy is part of the schema contract

The legacy host seed policy fixture granted access **by collection name**. Replacing the schema
silently invalidated every grant: `companies`, `jurisdictions` and the other new collections had no
grants at all, so the HR controller's queries returned zero rows.

The symptom was a combobox rendering _"No options available"_ while the database held six companies.
Nothing failed — the user simply could not see anything. The policy fixture was maintained outside
generated output, so schema regeneration never touched it.

Rewritten against the new collections, with the jurisdiction-level rows split into a
`statutoryCollections` group that is **read-only for every role**. That puts chapter 01's one-way wall
into the permission layer: a company may read the law to explain a figure on a payslip, and no role
may write it.

### Two agents, one column, two contracts

`statutory_contributions.special_rules` is `text[]`. The engine treats it as an **executable closed
token set** and throws on anything it does not implement. The statutory decomposition used it as a
**documentation field** for behaviour the structured model could not express —
`FOREIGN_EMPLOYEE_FLAT_2_PERCENT`, `INSURED_SALARY_GRADE_TABLE`, and a dozen more across the five
jurisdictions.

The blocking error was the harmless half. The dangerous half is the inverse: **Malaysian EPF declared
no `BRACKET_STEP` token and PCB declared no relief tokens**, so the Third Schedule bracketing and the
9,000 / 4,000 / 350 reliefs would simply not have fired — every Malaysian EPF and PCB figure wrong,
with no error anywhere.

That defect was caught _only_ because the engine refuses to run against a rule it cannot honour
instead of skipping it. A permissive engine would have produced a complete, plausible, wrong payroll.
The resolution keeps the field executable, moves annotations into `authority`, and adds a validator so
the two vocabularies cannot drift again.

---

## D2. A platform bug that silently disabled type checking on every custom type

`packages/pod/src/lib/vite/compiler/index.ts` generated each custom type's `$types.d.ts` with a **`.ts`**
extension:

```ts
import type definition from '../../../src/custom-types/proration_basis/+definition.ts';
```

Without `allowImportingTsExtensions` that import does not resolve, and `skipLibCheck` hides the failure
inside the `.d.ts`. So `definition` became `any`, and therefore:

> **`Value` was `any` in every custom-type renderer in every template workspace** — `hr-payroll`,
> `bca`, `construction` and `crm` alike.

A sibling generator 100 lines earlier emits the same import correctly with `.js`.

Fixed by normalising the extension. The effect was immediate and worth recording: re-running the type
check surfaced **41 previously-invisible errors** in the new engine's contribution-band selection,
all of the same shape —

```
Property 'from'     does not exist on type '{ by: "RISK_CLASS"; class: string; }'
Property 'age_from' does not exist on type '{ by: "WAGE"; from: number; to: number | null; }'
```

i.e. the code was reading `selector.from` / `selector.to` / `selector.age_from` without narrowing on
the `by` discriminator. A `RISK_CLASS` selector has no wage band and a plain `WAGE` selector has no age
range, so unguarded reads would mis-select a contribution band or throw at runtime. That is precisely
the class of defect the discriminated-union modelling in ch. 01 §3 exists to prevent — and the compiler
had been unable to enforce it.

**Any renderer or engine code written against these types before this fix was unverified.**

---

## E. Latent bugs in the legacy engine (fixed, not reproduced)

| bug                                                           | effect                                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| YTD keyed on `employment_id`                                  | PCB and relief pools reset on transfer or rehire. Zero effect on Nihon 2026; wrong for the first customer with a transfer |
| YTD includes `DRAFT` runs (no lifecycle filter)               | silent misstatement whenever a draft is discarded. Feeds both the PCB projection and the relief caps                      |
| Reversal sign is a non-transitive `reverses_id ? −1 : 1`      | reversing a reversal **doubles the negative**                                                                             |
| ORP day divisor is a literal `6`, not `working_days_per_week` | coincides with Nihon's 6-day roster, so invisible — **20% overtime-rate error for any 5-day-week customer**               |
| No 1-hour minimum on sub-hour overtime                        | spec ch. 06 rule 5 has no counterpart in code                                                                             |

---

## F. What is new work with no parity constraint

Not implemented anywhere in legacy, so nothing to reproduce: `RISK_CLASS` selectors,
`SPECIAL{rule}` treatments, `rate_override`, `DAY_WAGE_MULTIPLE`, the overtime `minimum` override,
`overtime_limits`, the negative-net guard and arrears, leave encashment, the entire leave ledger with
derived accrual and carry-forward, the whole claim cap layer, and payslip replay.

Notably, **legacy has no leave accrual at all** — `carried_forward` is literally `0`
(`entitlements.ts:151-152`). Payroll never reads a leave _balance_, only unpaid-leave allocations, so
chapter 07 can be built independently of parity.

---

## G. Residual platform risk

The PGlite offline client receives **columns-only DDL** — no indexes, no constraints. The nine new
exclusion constraints therefore exist server-side only: an offline write that violates one succeeds
locally and fails only on push. The sync engine performs **no SQLSTATE inspection anywhere**, so
`23P01` (exclusion_violation) and `23505` are indistinguishable from a transient fault; `flushPending`
discards the mutation for any non-`OFFLINE_QUEUED` result, and its rollback restores the
already-optimistically-applied value. A rejected offline write is silently dropped and the local
replica keeps diverging.

Out of scope for this refactor, but it is now reachable in a way it was not before.
