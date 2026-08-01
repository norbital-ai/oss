# BCA Field Operations documentation

## Goal

Turn a scheduled field job into a qualified contractor assignment, trustworthy field evidence, and a
traceable scope-change request. BCA is for day-to-day site operations where dispatch quality and evidence
matter more than broad project portfolio management.

## Who it serves

| User       | Outcome                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| Controller | Schedules work, checks contractor qualifications, and oversees exceptions.     |
| Contractor | Sees assigned work, records progress and location, and submits field evidence. |
| Supervisor | Reviews flagged location updates, variation requests, and duplicate evidence.  |

## Workspace guarantees

- A job belongs to an existing site and is assigned at most once.
- An assignment is accepted only when the contractor holds every required certification.
- Inbound assignment and variation requests can be retried safely through `source_message_id`.
- Assignment identity is immutable after dispatch; completion and job state remain synchronised.
- Evidence is JPEG or PNG, attached to exactly one assignment or variation, and inspected for duplicate
  and metadata-quality signals.

## Scope boundary

This template does not provide a project portfolio, cost ledger, payroll, or an approval-state machine.
The platform’s approval system owns approval, rejection, rollback, and audit history for variation
requests. Add integration or commercial modules only when the operating model genuinely requires them.

## Start points

- [Workspace README](../README.md) — full operating flow, collection map, and verification.
- `src/collections/job_assignments/+hooks.ts` — qualification, idempotency, progression, and location rules.
- `src/collections/photo_evidence/+hooks.ts` — evidence parenting and integrity inspection.
- `src/remotes/+bca_dashboard.ts` — controller dashboard data shape.
