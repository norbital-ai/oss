# HR & Payroll documentation

## Goal

Calculate multi-country payroll from governed employment facts, time, leave, component definitions, and
statutory rules. The template separates what happened from what must be derived, so a payroll result can
be traced and reconciled instead of copied from a legacy system.

## Who it serves

| User                         | Outcome                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| HR and people operations     | Maintains employment, terms, leave, shifts, rosters, and payroll inputs.                   |
| Payroll and finance          | Runs validated settlements and reconciles compact payslip outputs.                         |
| Product and compliance teams | Configure jurisdictions, contribution rules, component treatments, and statutory minimums. |

## Non-negotiable boundaries

- Enter or import observed source facts; do not seed derived overtime, gross pay, contributions, net pay,
  leave balances, or payroll outputs.
- Pay-component tax and contribution treatment belongs to component type and jurisdictional treatment,
  not to a free-form flag on an individual component.
- `UNSET` treatment cells block activation so a new kind of pay cannot silently enter a jurisdiction.
- The platform owns approval identity and history. Payroll reads the approved/settled predicate instead of
  recreating local approval-state columns.
- Reconciliation reports unexplained differences; it never fabricates input to force zero variance.

## Start points

- [Workspace README](../README.md) — the engine, eight-step run, approval model, and verification.
- [`plan/`](../plan/) — the detailed design chapters; begin with conventions and the type/treatment grid.
- `src/collections/payroll_runs/lib/` — settlement implementation.
- `scripts/verify-payroll-arithmetic.mjs` — arithmetic invariants independent of the database.
