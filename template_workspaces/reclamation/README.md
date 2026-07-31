# Reclamation Template

Land reclamation project workspace. Three survey documents per project — a floor plan, a
bathymetric survey, and a section sheet — are stitched server-side into one 3D site solid; that
solid is integrated for volumes, and the volumes are priced against a shared unit cost matrix.

It is a take-off and option-appraisal tool for reclamation works. It is not a CAD system, a
dredging design package, or a bill of quantities: it will not draw for you, and it will not
replace a surveyed as-built.

For the goal, users, and extension boundaries, see the
[Reclamation documentation hub](./docs/README.md). For the stitching mathematics and the full
assumption catalogue, see [How the stitch works](./docs/RECONSTRUCTION.md).

## Operating model

1. Create a **project** and set its datum, currency, and interpolation mode.
2. Attach the three documents. Saving the project runs the stitch hook.
3. Open the project. The left panel holds documents, quantities, and the assumption ledger; the
   right panel renders the reconstructed site at full resolution.
4. Maintain the **cost matrix** — one unit rate per substrate, shared by every project.
5. Create a **cost estimate** against a reconstruction revision. Commercial levers are the only
   numbers an estimator types; quantities come from the solid and totals recompute on every save.

## Layout

Pod discovers the workspace from the filesystem. `vite.config.ts` contains the only root entry point.

```
reclamation/
├── vite.config.ts                        # pod() root entry point
├── src/collections/+relationship.ts
├── src/collections/reclamation_projects/
│   ├── +model.ts                         # project and its three document fields
│   ├── +hooks.ts                         # THE RECONSTRUCTION HOOK
│   ├── lib/run-stitch.ts                 # stitch driver: read assets, run, record a revision
│   ├── +representation.svelte
│   └── project-representation.svelte     # left panel + right-hand 3D panel
├── src/collections/site_reconstructions/ # derived solids, one row per stitch run
├── src/collections/cost_rates/           # the unit cost matrix
├── src/collections/cost_estimates/       # priced take-offs (+hooks.ts prices them)
├── src/remotes/+rebuild_reconstruction.ts
├── src/apps/+reclamation_projects.svelte
├── src/apps/+reclamation_cost_matrix.svelte
├── src/lib/reclamation/                  # the engine — pure, isomorphic, no framework
└── src/lib/site-viewer/                  # the 3D viewer and its tessellation worker
```

## Collections

| Collection             | Purpose                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `reclamation_projects` | Projects and the three documents the reconstruction is stitched from.     |
| `project_documents`    | Every other document: further reconstruction inputs, tender, reference.   |
| `site_reconstructions` | One row per stitch run: model, integrated volumes, and assumption ledger. |
| `cost_rates`           | Unit rate per substrate, shared across projects.                          |
| `cost_estimates`       | Priced take-offs against one reconstruction revision.                     |

`reclamation_projects` → many `project_documents`, `site_reconstructions`, and `cost_estimates`;
each estimate also points at the exact reconstruction revision it priced.

### Two kinds of attachment

The three primary documents live on the project record because the reconstruction cannot run
without them. Everything else is a `project_documents` row, and its **category** decides what
happens to it:

| Category         | Role                                            | Effect                                           |
| ---------------- | ----------------------------------------------- | ------------------------------------------------ |
| `reconstruction` | `additional_sections` / `additional_bathymetry` | Read by the stitch. Saving one re-runs it.       |
| `reconstruction` | `supporting`                                    | Filed with the reconstruction set; never parsed. |
| `tender`         | —                                               | Filed only. Cannot change a quantity.            |
| `reference`      | —                                               | Filed only. Cannot change a quantity.            |

An extra perimeter section is the single most useful thing a project can add: each one replaces a
stretch of interpolation with measurement. Extra surveys pool their soundings into the same bed.

## The three documents

Everything the model knows comes from these, and nothing else. The engine never invents a site
dimension: no shoreline length, no platform level, no slope multiplier appears anywhere in the
TypeScript.

| Document           | Supplies                                                          | Accepted formats                    |
| ------------------ | ----------------------------------------------------------------- | ----------------------------------- |
| **Floor plan**     | Works outline, seaward perimeter, existing land, structures, cuts | `.dxf`, plan `.json`                |
| **Bathymetry**     | The existing bed under the works                                  | `.xyz`, `.csv`, `.dxf` points       |
| **Cross sections** | Levels, slopes, crest and armour dimensions                       | authored `.dwg`, `.dxf`, or `.json` |

Native DWG entities are decoded with LibreDWG. Vector tender PDFs are detected as vector source
drawings, but plotted-sheet coordinates are not treated as metres: section recognition and
dimension-based scale calibration must complete before their paths can enter the geometry engine.
CSV profile reconstructions are rejected.

## Calibration: what your drawings must carry

The engine places the works in space from a small set of references. Without one
of them the shape cannot be deduced — only guessed at — so **the stitch refuses
rather than producing a solid that looks right and measures wrong**. Every
shortfall is reported in one message, so a single pass fixes them all.

### Required — the stitch fails without these

| #   | Reference                     | Where                                               | Why it is required                                                                                                                                                                                  |
| --- | ----------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Closed works outline**      | Floor plan, `WORKS`/`SITE` layer or `works_outline` | The reclamation extent at the toe. Everything inside it is the site.                                                                                                                                |
| 2   | **Seaward edges**             | Floor plan, `TOE`/`QUAY` layer or `seaward_edges`   | Which edges face water. **Station 0 is measured from them.** Without it a boundary against existing land gets a revetment it will never have. For a wholly offshore site, trace the entire outline. |
| 3   | **Toe marker**                | Section, layer `toe` (or `quay_crest`)              | The origin of the station axis, and what distinguishes a perimeter section from one drawn across an internal bund.                                                                                  |
| 4   | **Platform marker**           | Section, layer `platform`                           | Fixes the top of the fill. Without it the engine can only take the highest point drawn, which may be a bund crest or a wall coping.                                                                 |
| 5   | **Survey covering the works** | Bathymetry                                          | Fill depth is the difference between two elevations. Below 60% coverage of the outline there is nothing to measure against.                                                                         |

A drawing set with its own vocabulary maps onto 3 and 4 with `profileLayers.toe`
and `profileLayers.platform` in the project overrides; 4 can also be satisfied
outright with `levelsM.platform`.

### One datum, one frame

Every elevation — section levels, sub-grade inverts, and soundings — is read as
**signed values on the project datum** (Chart Datum in the shipped packs):
negative below it, positive above, the seabed included. A trench invert is dug by
comparing it against the surveyed bed on that same datum, never by assuming a
depth. Plan XY, section stations, and survey XY are metres in one shared local
frame; no projection or transform is applied.

Nothing checks that the two documents _are_ on the same datum — it cannot be
inferred. What the engine can do, and does, is report the consequences: the survey
coverage check catches a frame mismatch, and `design-below-bed` catches a datum
offset by showing the works sitting under the seabed.

### Strongly recommended — assumed, and reported, if absent

| Reference                                                      | If absent                                                                                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crest_seaward` / `armor_crest` / `crest_landward`             | Zone limits fall back to "the face runs from the toe to where the section first reaches its highest point".                                        |
| `hwm`                                                          | The face is not split at the water line.                                                                                                           |
| Armour thickness (annotation, or `dimensionsM.armorThickness`) | Derived as `t = 2B/3` from the armour crest width, or the armour and geofabric lines price at zero with an error-severity warning. Never invented. |
| Sub-grade inverts (`sand_key`, `dredged_rock`)                 | Priced as a prism from the stated dimensions instead of dug against the real bed.                                                                  |
| A section per chainage where the detail changes                | One section is carried around the whole perimeter.                                                                                                 |
| `interim`                                                      | The fill material change is taken at datum zero.                                                                                                   |

### Floor plan layers

A DXF is read by layer. The default mapping, overridable per project through `stitch_overrides`:

| Meaning                            | Default layers                                   |
| ---------------------------------- | ------------------------------------------------ |
| Works outline (closed, to the toe) | `WORKS`, `EXTENT`, `RECLAMATION`, `SITE`         |
| Finished platform (closed)         | `PLATFORM`, `FILL`, `SITE`                       |
| Seaward perimeter (open polylines) | `TOE`, `QUAY`, `REVETMENT`, `SEAWARD`            |
| Containment pond (closed)          | `LAGOON`, `POND`, `CONTAINMENT`                  |
| Existing land (closed)             | `LAND`, `EXISTING`, `EXISTING_LAND`              |
| Adjacent or future works (closed)  | `CONTEXT`, `ADJACENT`, `FUTURE`, `PHASES`        |
| Existing structures (closed)       | `TBUND`, `STRUCTURE`, `EMBANKMENT`, `BREAKWATER` |
| Section cut lines + `SEC x-x` text | `SECTIONS`, `SECTION`, `CUTS` + `TEXT`           |
| Ignored                            | `GRID`, `DIMS`, `TITLE`, `BORDER`, `0`           |

A layer in none of these lists is ignored **and reported** in the run's warnings, so nothing
disappears silently. Context polygons are drawn so the site reads in its setting — an adjacent
phase, an adjoining terminal — and are never integrated or priced.

### Section layers

Section points are classified by their `layer`: on the finished surface, or on an internal or
below-grade interface. The keyword lists are defaults, not a schema. A drawing set with its own
vocabulary is mapped through `profileLayers` in the project overrides, and **every run reports how
each layer it actually saw was read**, in the Model tab.

A section is treated as a _perimeter_ section only when it reaches the toe. If no section names a
toe at all, every section is taken as perimeter — the only reading available — and that is recorded
as an assumption rather than guessed at silently.

## How the stitch works

```
floor_plan.dxf   bathymetry.xyz   cross_section.dwg
      │                │                  │
      └────────────────┴──────────────────┘
                       ▼
        reclamation_projects/+hooks.ts   (server, create.after / update.after)
                       ▼
   parse ─→ extract ─→ normalise ─→ StitchedModel ─→ integrate ─→ volumes
                       │                                             │
                       └── assumption + warning ledger ──────────────┘
                       ▼
              site_reconstructions row (model_json · quantities_json · report_json)
                       │
      ┌────────────────┴──────────────────┐
      ▼                                   ▼
 cost_estimates/+hooks.ts            site_viewer worker
 volumes × rates → money             the same model → triangles
```

The hook owns the geometry decision; the browser owns the triangles. Both call the _same_ sampler
module over the same model, so a quantity in the estimate is the volume of the shape on screen —
not a parallel calculation that happens to agree.

### Step 1 — extract

Each document is decoded and interpreted by named, deterministic rules. Precedence is fixed:
project overrides, then the section sheet for every elevation and slope, then the floor plan for
every plan extent, then the survey for the bed, then engine defaults. A default is always recorded
as an assumption; a disagreement between documents is always recorded as a warning that names the
winner.

Levels and slopes are _derived_, not guessed:

- **Toe / platform / HWM** — the elevations of the `toe`, `platform`, and `hwm` points.
- **Seaward face slope** — from the profile segment leaving the toe, not the chord across the
  whole face. A face drawn `1V:3H` reads back as exactly `1V:3H`.
- **Crest width** — station of `crest_landward` minus station of `crest_seaward`.
- **Structure face slope** — from the bed-contact segment of a `*_face` layer on a section that
  crosses that structure.
- **Vertical face** — a section with two elevations at station 0 is a caisson or quay wall, and no
  armour blanket is built.

### Step 2 — the perimeter model

The works are a closed outline plus the subset of its edges that face water.

> **station = shortest distance from the cell to the nearest seaward edge**, increasing inward.

That single rule handles a straight coastal strip, a curved shoreline, and a comb of finger piers
with berth basins between them. Edges left out of the seaward set — a boundary against existing
land, a phase joint — get no face, and cells near them simply read as platform.

Where several sections are supplied, each is placed on the perimeter at the point its cut line
comes closest to a seaward edge, and geometry is blended between neighbours **by distance along
the perimeter**.

### Step 3 — integrate

Every plan cell inside the outline is a column running from the _existing_ surface to the finished
design surface:

```
existing surface = max(surveyed bed, crest of any pre-existing structure standing there)
column height    = design surface − existing surface
```

- **Rock armour** takes the outer skin of the face. Thickness is specified perpendicular to the
  face, so it is converted to a vertical column by `t_vertical = t × hypot(v, h) / h`. At 1V:3H,
  1.50 m perpendicular is 1.58 m vertical. The blanket is _drawn_ as a real layer of that
  thickness, with an underside and a rim, so what is priced is what is on screen.
- **Geofabric** is the sloped face area under the armour, `cell area × hypot(v, h) / h`.
- **Fill** is everything else, split at the material-change level on the platform and taken as
  bund sand on the perimeter.
- **Sub-grade bands** — a section layer drawn _below_ the finished surface, such as a sand key
  trench or a rock foundation, is read as its own material band with an invert on the datum. It is
  dug against the surveyed bed by comparing two elevations, and the same volume is the substrate
  placed back into it. Those stations are often negative, seaward of the toe, so the integration
  grid reaches beyond the outline to cover them.
- **Where the design lies below the bed** the column is a cut. It is reported as `excavation_m3`
  and deliberately not priced — the substrate matrix has no dredging rate.

The substrate lines sum to `placed_volume_m3` exactly, so a take-off reconciles without
multiplying rounded metrics.

This is `∫(z_design − z_bed) dA` over the survey, cell by cell. It is not a mean-depth prism, and
it is not a factor applied to the platform area.

Cells that straddle a zone limit are re-integrated on a 4×4 sub-grid. The armour band is only a few
cells wide, so a boundary quantised to whole cells would move the armour volume by several percent
depending on how the grid happened to fall across it. With refinement, the same site rotated 37°
and translated 48 km prices its armour within 1.3%, and its fill within 0.01%.

Sand key and dredged rock stay analytic prisms — the section dimensions them, the plan does not
draw them — and each says so in its own `basis` string.

### Step 4 — price

```
priced quantity = stitched quantity × lever factor
subtotal        = Σ priced quantity × rate
total           = subtotal × (1 + contingency)
```

Commercial levers are placement loss on sand, placement loss on dredged fill, a perimeter margin
for an uneven reclaim edge, PVD treated-area and spacing, and contingency. Rates quoted in a
currency other than the estimate's are dropped rather than converted: this workspace holds no
exchange rates, and a silent conversion is worse than a visibly missing line.

#### Every measured substrate must have a rate

`src/lib/reclamation/substrates.ts` is the single registry of what the engine can measure. A
substrate that comes back with a quantity and has no rate in the matrix is an **error**, not a zero:
the panel refuses to save and the `cost_estimates` hook throws. A total that quietly omits a
material is worse than no total, because it looks finished.

A substrate the site does not use — armour on an all-caisson quay, a sand key nobody drew — is
measured as zero and needs no rate. Only what the solid actually contains is demanded.

| Substrate    | Unit | Where the quantity comes from                              |
| ------------ | ---- | ---------------------------------------------------------- |
| Rock armour  | m³   | Integrated: thickness × the true sloped face area          |
| Geofabric    | m²   | Integrated: the same sloped face area                      |
| Dredged rock | m³   | Analytic prism from the section's core dimensions          |
| Sand key     | m³   | Integrated against the surveyed bed, trench by trench      |
| Sand fill    | m³   | Integrated: bund zones, column by column                   |
| Dredged fill | m³   | Integrated: platform columns below the split level         |
| PVD          | m    | Analytic from platform area, treated fraction, and spacing |

#### What is deliberately left out

Seven items are a **manual take-off**, listed in `MANUAL_TAKE_OFF` and shown at the bottom of the
cost tab. They are excluded because a plan, a survey, and a section do not contain what decides
them — not because they are small:

| Item                  | Why it cannot be measured from the documents                                          |
| --------------------- | ------------------------------------------------------------------------------------- |
| Caisson concrete      | Wall geometry and reinforcement come from the structural drawings, not the site plan. |
| Caisson founding      | Bedding, scour protection, and founding treatment are detailed per berth.             |
| Dredging and disposal | Priced by material and disposal ground, not by shape. The cut volume _is_ reported.   |
| Temporary works       | Access bunds, silt curtains, and haul roads are a method choice.                      |
| Surcharge             | Height and duration follow a settlement analysis.                                     |
| Services and pavement | Above the platform level this model stops at.                                         |
| Monitoring and survey | A programme cost, not a quantity.                                                     |

### Step 5 — simulate

Two kinds of lever, and the difference matters.

**Commercial levers** change only what is priced. They recompute instantly and never touch the
solid.

**Design levers** change the solid. Platform level, bed level, face batter, armour thickness, and
sub-grade invert each rewrite the model and re-run the whole integration in the Web Worker, through
`applySimulation()` and the same `integrateSite()` the server called. The volumes that come back are
those of a real alternative design — not a factor on the base case. Raising the platform by 1 m adds
one metre of fill over the whole footprint, and doubling armour thickness doubles the armour line
exactly — both asserted in `pnpm verify`.

A simulation is exploratory and is never persisted. To keep one, change the project and re-stitch.

## Assumptions that change how the model looks

Every run records these on `site_reconstructions.report_json`, and the project panel shows each one
with what happens if it is wrong. The ones that most affect the shape:

| Assumption                             | What it means                                                                                             | If it is wrong                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **One metric frame**                   | All three documents are metres in one local frame. No projection, no transform.                           | The solid still builds and looks plausible while sitting over the wrong bed. Check coverage first.                      |
| **Constant seaward batter**            | The face holds the section's slope at every point of the perimeter, straight from toe to crest.           | Armour volume, geofabric area, and toe position all move with it. A 10% flatter face adds roughly 10% to armour area.   |
| **Linear morph between sections**      | Between two cuts, elevation and the zone limits interpolate linearly along the perimeter.                 | A face that turns or steps between two sheets is drawn as a ruled sweep. Error peaks midway and is zero at each cut.    |
| **Station is distance to perimeter**   | Sections are applied normal to the nearest water-facing edge.                                             | At a re-entrant corner two faces claim the same ground and the nearer wins, so a real fillet is drawn as a sharp mitre. |
| **Platform runs level inward**         | Beyond the last section station the level is held constant across the outline.                            | Landward grading, drainage falls, and terracing are missing.                                                            |
| **Armour thickness**                   | Not derivable from a design polyline; taken from an annotation, an override, or the Detail-A crest width. | The single largest lever on the armour line — it scales linearly.                                                       |
| **Structures are one straight batter** | A pre-existing bund is its footprint at crest level with one straight face to the bed.                    | A bund with a berm or two different batters displaces a different amount of new fill.                                   |
| **Bund priced as sand**                | Armour and crest zones are bund sand; only platform columns split at the material level.                  | Volume moves between the sand and dredged rates without changing the solid.                                             |
| **Containment ponds carry no fill**    | Pond footprints are open water inside the bund.                                                           | If the ponds are closed later, platform fill is understated by their area × depth.                                      |
| **Interpolated bed cells**             | Cells with no sounding are filled from neighbours, then from the toe level.                               | Fill depth over an unsurveyed pocket carries the interpolation error.                                                   |

The full catalogue, with the code that raises each entry, is in
[docs/RECONSTRUCTION.md](./docs/RECONSTRUCTION.md).

## The project view

A `Split`: controls and derived numbers on the left, the solid on the right. The viewer stays
mounted across tab changes, so moving between tabs never costs a re-tessellation.

| Tab           | Holds                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------ |
| **Documents** | The three reconstruction inputs with their provenance, plus the project's other documents. |
| **Model**     | Layer switches, render quality, measured metrics, and the assumption ledger.               |
| **Cost**      | Design and commercial levers, priced lines, totals, the manual register, and _save_.       |

Layer switches change mesh visibility in the live scene — no rebuild. Render quality (Draft 8 m,
Standard 3 m, High 1.5 m) does rebuild, so it is a deliberate, separate control, and the panel
states plainly that it changes only what is drawn: volumes come from the server integration.

Both kinds of lever run in the browser against the _same_ engine the server uses, so a slider
cannot disagree with what saving would produce. Commercial levers answer instantly; a design lever
re-integrates in the worker and reports the new volume against the design as drawn. Nothing is
written until the estimate is saved.

### Why full fidelity is affordable

The work is split correctly. The server stores one compact
model — polygons, section profiles, and a gridded bed, tens of kilobytes — never a mesh. The
browser turns that into triangles once, in a Web Worker, and transfers the typed arrays instead of
copying them. Resolution is a project setting (`render_cell_m`), so raising it costs triangles but
never changes the shape being described. Layers can be toggled individually, and the triangle count
and cell size are shown in the corner.

The surveyed bed is drawn at the **survey's own resolution** — it is measured data, and decimating
it would draw a smoother seabed than the one the volumes were integrated against. It is thinned
only when a dense survey would exceed the vertex budget, and the applied step is reported.

Three.js is loaded from a CDN at runtime rather than bundled, matching the IFC viewer in the
construction template.

## Rebuilding a reconstruction

Saving a project stitches it. `src/remotes/+rebuild_reconstruction.ts` covers the two cases a save
does not: documents that arrived through a seed or an import (those write straight to the database
and never reach a hook), and a re-run against a newer engine version. It is idempotent — unchanged
inputs return `skipped` — and `force` appends a fresh revision anyway.

A revision is never overwritten. An estimate points at the revision it priced, so the geometry
behind a number cannot change under it.

## Sample data

None ships here. The public template contains models, hooks, apps, and the reconstruction engine,
and no site data of any kind. Demonstration document packs are Core-owned and live outside this
repository.

To try the workspace, supply your own three documents in the formats above, or digitise a site to
the schemas in [docs/RECONSTRUCTION.md](./docs/RECONSTRUCTION.md).

## Verification

```bash
pnpm --dir template_workspaces/reclamation sync
pnpm --dir template_workspaces/reclamation lint
pnpm --dir template_workspaces/reclamation verify
pnpm --dir template_workspaces/reclamation build
```

`verify` runs `scripts/verify-engine.ts` — 21 checks, no test framework and no dependency, straight
on `node`. Three groups:

**Against calculus.** Shapes whose answer can be worked out by hand, so a plausible-looking wrong
number cannot pass: a square pad against the closed-form volume of its four ramps and corners
(0.000% at a 2 m cell), armour against thickness × true sloped area, the footprint against the
shoelace area, and a parabolic bed against its exact integral — where pricing off a mid-depth prism
instead would be 6.3% out. It also asserts the substrates partition the solid exactly: they sum to
the placed volume to seven significant figures, so nothing is double-counted or dropped.

**Against generality.** Sites the engine has never seen — a comb of finger piers with three
different sections, a foreign section vocabulary mapped through `profileLayers`, 40 arbitrary star
polygons — plus the invariance no hardcoded dimension could survive: the same site rotated 37° and
translated 48 km prices within 0.00% on fill and 0.20% on armour. Uncalibrated drawings must be
_refused_, naming every shortfall in one message.

**Against the cost rules.** A matrix missing a rate for a measured substrate must produce an error,
and a complete one must price cleanly. Design levers must move volume in the physically right
direction and by the right amount.

All 21 pass. See [docs/RECONSTRUCTION.md](./docs/RECONSTRUCTION.md#what-generality-means-here).

## Stack

Pod · Svelte 5 · TypeScript · Three.js (loaded at runtime)
