# Construction Operations documentation

## Goal

Give field, safety, project, and commercial teams one project-operating model for work fronts,
qualifications, permits, defects, RFIs, claims, documents, and BIM reference data.

## What the template optimises

| Concern                | Template behaviour                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| Workforce compliance   | A worker assignment requires a currently active permit whose certifications satisfy a linked site job. |
| Delivery control       | Jobs, RFIs, defects, asset documents, and site locations share project context.                        |
| Commercial review      | Payment claims carry claim status, amount, period, and supporting documents.                           |
| Operational visibility | Four scheduled watches export bounded daily review data for permits, defects, RFIs, and claims.        |

## Scope boundary

The workspace is an operational system of record, not a BIM authoring product, a construction ERP, or a
permit authority. The scheduled watches do not notify or mutate records by themselves; add a delivery
integration deliberately when alerts are required.

## Start points

- [Workspace README](../README.md) — operating model, collections, relations, and verification.
- `src/collections/job_assignments/+hooks.ts` — the server-side compliance gate.
- `src/policies/` — three read-only roles that differ only in which application they open, and why
  that is the right narrowing here.
- `src/automation/` — daily review exports.
- `src/lib/ifc-viewer/` — the embedded IFC viewer and converter worker.
