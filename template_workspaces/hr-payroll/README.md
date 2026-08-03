# HR & Payroll

This template turns approved employment, attendance, leave and money events into auditable payroll
results. It supports effective-dated terms, roster-based day classification, statutory
contributions, repayment schedules, draft recalculation, paid-run locking and source-linked
payslip lines.

The documentation is deliberately split by responsibility:

- [`docs/architecture`](docs/architecture/README.md) explains the live payroll engine, including
  cutoffs, overtime, adjustments, ledgers, provenance and locking.
- [`docs/data`](docs/data/README.md) defines the raw-source → cleaned-source → seed contract and the
  checks that prevent derived output from leaking back into inputs.

## Surfaces

Nine applications: `hr_employee` for self-service, and eight pages grouped under `hr_controller` —
people, scheduling, time and attendance, leave, loans, pay components, payroll, and settings. A
policy names the group rather than each page, so adding a controller page does not mean revisiting
every role declaration.

Three policies sit on those apps: `employee` scopes self-service to the requestor, `hr` administers
people, scheduling, requests, loans and payroll, and `management` reviews and runs payroll.

One remote, `approval_analytics`, supplies year-to-date approval counters and a five-year trend for
payroll runs, leave requests and claims. It is worth reading for how it phrases those counts: this
workspace has no approval column anywhere, and `norbital_approval_id IS NULL` is the only definition
of a live row.

`src/+agent.ts` declares the workspace agent, and declares it narrowly — write access to `companies`
alone, one host tool, and bounded iterations and tokens. An agent receives a grant here, not the
workspace.

## Operational boundary

Seed only payroll inputs. Never seed a payroll run, payslip, calculated overtime amount, statutory
contribution, gross, net or source incentive-overtime result. A run must calculate those values from
the input records and then be compared with an independently supplied source workbook.

## Runtime

The template pins `@norbital-ai/pod` in its own `package.json` and lockfile. Do not edit generated
`.norbital` output by hand. After a deliberate dependency move, refresh the template lock through
the repository template-lock workflow.

## Verification

The template includes focused arithmetic and export checks. Two run against the source and can be
invoked directly; the third reads the emitted server chunk and therefore only means anything after a
build, which is why `pnpm build` runs it rather than leaving it to be remembered:

```bash
node scripts/verify-payroll-arithmetic.mjs
pnpm test    # overtime controls, plus the repayment-agreement unit tests
pnpm build   # vite build, then verify-built-xlsx.mjs against what it emitted
```

The confidential source reconciliation is opt-in in Core; see
[`docs/data/reconciliation.md`](docs/data/reconciliation.md).
