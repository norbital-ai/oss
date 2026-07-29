# Reclamation documentation

## Goal

Give a reclamation project team one path from three survey documents to a defensible take-off: a
floor plan, a bathymetric survey, and a section sheet become one 3D site solid; the solid is
integrated for volumes; the volumes are priced against a shared unit-rate matrix — with every
assumption behind the shape written down beside it.

## What the template optimises

| Concern             | Template behaviour                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Site reconstruction | A server hook stitches the three documents into one solid on every save; each run is a kept revision.      |
| Quantity confidence | Volumes are integrated cell by cell against the surveyed bed, not estimated from a mean-depth prism.       |
| Traceability        | Every derived number states its basis; every default and conflict is recorded as an assumption or warning. |
| Cost estimation     | Estimates apply the rate matrix to a specific reconstruction revision and recompute on every write.        |
| Review              | The project view puts documents and quantities beside the solid they describe, at full resolution.         |

## Scope boundary

This is a take-off and option-appraisal workspace. It is not a CAD authoring product, a dredging
or geotechnical design suite, a bill-of-quantities system, or a substitute for a surveyed as-built.
The accuracy of the solid equals the accuracy of the documents fed to it: sections alone cannot
determine a planform, and a plan alone cannot determine a level.

Nothing here georeferences. All three documents are read as metres in one shared local frame.

## Start points

- [Workspace README](../README.md) — operating model, collections, and the stitching pipeline.
- [How the stitch works](./RECONSTRUCTION.md) — document schemas, derivation rules, and the full
  assumption catalogue.
- `src/collections/reclamation_projects/+hooks.ts` — the reconstruction hook.
- `src/collections/reclamation_projects/lib/run-stitch.ts` — the server driver that reads the
  document assets and records a revision.
- `src/lib/reclamation/` — the engine: parse, extract, sample, integrate, price.
- `src/lib/site-viewer/` — the 3D panel and its tessellation worker.

## Security and data boundary

The public template ships models, hooks, apps, and the reconstruction engine. It ships no site
data: no plans, no soundings, no section sheets, no seeds. Demonstration document packs are
Core-owned and live outside this repository.
