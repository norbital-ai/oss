# HR & Payroll

A multi-country payroll workspace. One engine, one set of eight steps, and no country named anywhere
in the code.

- **[PAYROLL_ARCHITECTURE_PLAN.md](PAYROLL_ARCHITECTURE_PLAN.md)** — the design, in 14 chapters under
  [`plan/`](plan/). Read `plan/01-conventions.md` and `plan/03-types-and-grid.md` first; they explain
  everything else.
- **[REFACTOR_FINDINGS.md](REFACTOR_FINDINGS.md)** — where the plan, the law and the source system
  disagree, and which one won. Read before changing any figure.
- **[CALCULATION_MALAYSIA.md](CALCULATION_MALAYSIA.md)** — the Malaysian arithmetic in longhand.

---

## The idea

A pay component never states its own tax treatment. It states **what kind of thing it is**, and the
law says what that kind is worth to each statutory scheme.

```
pay_components            component_types          contribution_treatments
  Transport    type ──►   FIXED_ALLOWANCE  ──►     × EPF   INCLUDE
  Overtime     type ──►   OVERTIME  ──┐            × SOCSO INCLUDE
  OT (weekend) type ──►   OVERTIME  ──┤
  Medical      type ──►   REIMBURSEMENT │          OVERTIME × EPF   EXCLUDE   ◄ stated once
                                       └────────►  OVERTIME × SOCSO INCLUDE
```

Fifteen overtime components can exist and every one is EPF-exempt, because the EPF Act is stated in
one row rather than restated per component. `pay_components` has no `epf` field, no `taxable`, no
`statutory_eligibility` — **the wall is the absence of a column**, not a permission rule.

The grid is never sparse. Adding a component type materialises a cell for every contribution in every
jurisdiction as `UNSET`, and `UNSET` blocks activation — so a new kind of pay cannot be introduced
without an explicit answer for every country.

---

## Seeded versus derived

The distinction the whole design rests on.

| Seeded — what happened                                                                               | Derived — everything that follows                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| base salary, employee profile, clocks, rosters, leave, claims, loans, plus the catalogue and the law | overtime hours and money, incentive overtime, contribution bases and amounts, gross, deductions, net, employer cost, every leave balance |

No calculated value is ever seeded, and the generator **enforces** it: a `component_entries` row may
only point at a component whose `definition.source` is `ENTRY`. `payroll_runs`, `payslips`,
`payslip_lines` and `payslip_contributions` are not seeded at all. Overtime and incentive components
exist in the catalogue as _definitions_; their values come from the clocks on every run.

Leave balances, claim caps and loan outstanding are likewise derived at read time. **Nothing in this
workspace runs on a schedule.**

---

## The run — eight steps

| #   | step       | does                                                                          |
| --- | ---------- | ----------------------------------------------------------------------------- |
| 1   | PICK       | resolve the governing configuration as of period end → `configuration_hash`   |
| 2   | VALIDATE   | everything that can be wrong before a person is read. Blocks                  |
| 3   | GATHER     | per employment: entries, leave, time, terms, statutory standing, year-to-date |
| 4   | MEASURE    | in component-type sequence, produce amounts → `payslip_lines`                 |
| 5   | ACCUMULATE | each line through the grid → contribution bases                               |
| 6   | CONTRIBUTE | each scheme in sequence: base → employee and employer amounts                 |
| 7   | SETTLE     | gross, total deductions, net, employer cost                                   |
| 8   | PERSIST    | payslip, lines, charges, and what each line consumed                          |

Step 5 never names EPF. Step 6 never names overtime. Neither knows Malaysia.

The engine lives in [`src/collections/payroll_runs/lib/`](src/collections/payroll_runs/lib/) and costs
about 15 ms of CPU per build; the rest of a run's wall time is database round trips.

---

## Approval

The platform provides it. Every table carries `norbital_approval_id` as a system column, and payroll
defines no approver routing, no pending flag and no rejected state.

| `norbital_approval_id` | meaning                     |
| ---------------------- | --------------------------- |
| not null               | pending — locked, immutable |
| null                   | in force                    |

The engine reads one predicate everywhere: `WHERE norbital_approval_id IS NULL`. There is no
`if (approved)` in it. Rejection _undoes the write_ — the row rolls back from `_history` — which is
why there is no rejected state to model.

Two balances follow, and using the wrong one overdraws: **settled** (`approval_id IS NULL`) is what
payroll acts on; **projected** (every row) is what a new request or claim is checked against, so that
a pending item reserves its budget.

---

## Correctness

### Reconciliation invariants

These are inputs to the reconciliation, not conclusions that may be tuned when a run differs:

1. **The customer's Infotech workbook is the financial oracle.** Salary, paid overtime, claims,
   deductions, statutory amounts, gross and net are compared to its employee-level values.
2. **No expected output is copied back as an operational input.** Base salary, employee standing,
   rosters, clocks, leave, claims and adjustments may be seeded when the source states them.
   Overtime money, gross, contributions and net remain derived. A source gap is reported as a
   variance; it is not filled with a fabricated event.
3. **Payable overtime comes from attendance and the effective schedule.** A shift must permit
   overtime, the duration must fall in that employee's cutoff, and the overtime must be authorised.
   Where the source has no approval flag, approval may be reconstructed only when eligible overtime
   is actually paid by Infotech in the applicable or following cutoff. Eligible overtime that is
   never paid is recorded as unauthorised.
4. **Every payable overtime hour uses the statutory award.** In Malaysia that is ordinary-day
   overtime at 1.5×, the stepped rest-day award, and the public-holiday award. Total work is
   generally limited to 12 hours in one day, while overtime under section 60A(4) is limited to 104
   hours in one month. Rest-day and public-holiday work is excluded from that 104-hour counter.
5. **Incentive OT is an excess-work classification, not extra money.** The same statutory value
   moves to incentive OT when total work exceeds 12 hours in a day or ordinary/off-day OT exceeds
   104 hours in its calendar month. This payroll treatment does not make excess work lawful.
6. **The 104-hour counter is calendar-month based.** The settlement cutoff never resets it; rest-day
   and public-holiday work is excluded.
7. **Cutoffs are component- and cadence-specific.** Nihon monthly salary covers the calendar month,
   while OT and ordinary NPL cover the 21st of the previous month through the 20th. OPSPH monthly OT,
   night shift and NPL use that same 21st–20th window. OPSPH semi-monthly OT and night shift use the
   1st–15th, while semi-monthly NPL still uses 21st–20th; 21–30 December NPL settles in the January
   mid-month payroll.

When the workbook and statutory law conflict, the engine must remain lawful and the report must name
the employee, output, amount and reason. “Zero variance” therefore means zero **unexplained**
variance, not silently reproducing an unlawful or unsupported legacy result.

Two checks guard the arithmetic:

```bash
node scripts/verify-payroll-arithmetic.mjs
```

```bash
pnpm --filter @norbital-ai/core test:e2e:payroll
```

The first is 159 assertions over the places where the arithmetic is not obvious — cumulative PCB,
EPF bracketing, SOCSO band-by-ceiling selection, the overtime floor, the daily-ceiling split, leave
accrual rounding — and touches no database. The second is full parity against the workbook.

The parity gate is two-sided: a difference not in `payroll-parity-baseline.json` fails the run, **and**
a baseline entry that no longer differs must be removed. The baseline cannot be used to paper over a
regression.

---

## Updating a deployed local tenant

Editing this directory does not change an existing tenant checkpoint. With Core running, publish the
checked-in template source, rebase the tenant repository, apply committed migrations, and deploy:

```bash
pnpm tenant:update --org=norbital_hr --template=hr-payroll
```

`.norbital/migrations` is source history and travels with every template publication; generated build
output and caches do not. An ordinary update preserves tenant records; only `env:reset` reseeds them.

Use `pnpm env:reset --template hr-payroll` only when you intend to destroy all local data, caches,
service volumes, and builder images and recreate the environment from seed.

In staging, run the equivalent publish → rebase → migrate → deploy action from staff Command Center;
direct template publication is disabled in production.

---

## Structure

```
src/collections/    28 collections — see plan/02-data-model.md
src/custom-types/   the discriminated unions every variant column is validated against
src/apps/           hr_controller (payroll, people, leave, loans, scheduling, …) and hr_employee
src/lib/            cross-collection helpers
plan/               the design, 14 chapters
```

Levels, and who writes what:

| level        | holds                                                                  | written by             |
| ------------ | ---------------------------------------------------------------------- | ---------------------- |
| GLOBAL       | `component_types`                                                      | product, once          |
| JURISDICTION | contributions, rates, the grid, overtime rules, statutory leave minima | product, per country   |
| COMPANY      | pay components, leave types, shifts, holidays                          | the customer           |
| EMPLOYMENT   | terms, statutory standing                                              | HR                     |
| EVENT        | entries, requests, ledger, clocks                                      | anyone doing their job |

A company may read across the jurisdiction boundary. It may never write across it.
