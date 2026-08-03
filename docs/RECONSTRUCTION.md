# How the stitch works

The reference for the reconstruction: what each document must contain, the rules applied to it,
and every assumption the engine can record. The [workspace README](../README.md) is the summary;
this is the detail an engineer needs before trusting a volume.

## Where the code lives

| Concern                                     | Module                                                   |
| ------------------------------------------- | -------------------------------------------------------- |
| Slope, run, area, sampling primitives       | `src/lib/reclamation/math.ts`                            |
| DXF group-code reader                       | `src/lib/reclamation/dxf.ts`                             |
| Section sheet reading and calibration       | `src/lib/reclamation/sheet.ts`                           |
| XYZ / CSV / JSON decoders and gridding      | `src/lib/reclamation/parse.ts`                           |
| Section layer vocabulary                    | `src/lib/reclamation/profile-layers.ts`                  |
| Document interpretation, layer mapping      | `src/lib/reclamation/extract.ts`                         |
| Perimeter sampler, section blending         | `src/lib/reclamation/surface.ts`                         |
| Volume integration and tessellation         | `src/lib/reclamation/solids.ts`                          |
| Pipeline and the standing assumption ledger | `src/lib/reclamation/stitch.ts`                          |
| Levers, rates, money                        | `src/lib/reclamation/cost.ts`                            |
| Format triage, DWG and PDF refusal          | `src/lib/reclamation/normalize-drawing.server.ts`        |
| Stitch driver shared by hook and remote     | `src/lib/reclamation/stitch-driver.ts`                   |
| Reading the assets and recording a run      | `src/collections/reclamation_projects/lib/run-stitch.ts` |
| The hook itself                             | `src/collections/reclamation_projects/+hooks.ts`         |

The engine has no framework, DOM, or Node dependency. `stitch()` is bytes in, JSON out, which is
why the same modules run in the server hook and in the browser tessellation worker.
`normalize-drawing.server.ts` is the one deliberate exception, and it sits outside `stitch()`: it
runs before extraction, decides whether a document can be read at all, and is the only module that
reaches for a PDF decoder.

## Frame and conventions

- Metres, in one local frame shared by all three documents. No projection is applied and no
  georeferencing is attempted.
- `X` and `Y` are plan coordinates; `Z` is elevation on the project datum.
- **Station 0 sits on the seaward perimeter and increases inward**, measured as the shortest
  distance to the nearest water-facing edge.
- Meshes are emitted in this engineering frame. The viewer rotates the group once, so no engine
  module knows about a rendering library.

## Document schemas

### Floor plan

**DXF.** Read by layer; see the mapping table in the README. Decoded entities are `LWPOLYLINE`,
`POLYLINE` + `VERTEX`, `LINE`, `POINT`, `TEXT`, and `MTEXT`. Blocks, splines, hatches, dimensions,
and 3D solids are skipped and counted in the run's warnings. `$INSUNITS` is checked and a value
other than metres raises a warning.

Section cuts are named by proximity: the cut line takes the label of the nearest text matching
`SEC 1-1` / `SECTION A-A`, and that label is matched to a profile id.

**JSON.** The digitised path:

```json
{
	"works_outline": [
		[0, 0],
		[600, 0],
		[600, 700],
		[3100, 700],
		[3100, 1450],
		[0, 1450]
	],
	"seaward_edges": [
		[
			[0, 0],
			[600, 0],
			[600, 700],
			[3100, 700]
		]
	],
	"platform_top_polygon": [
		[28, 28],
		[572, 28]
	],
	"lagoon_polygons": [
		[
			[400, 600],
			[700, 600],
			[700, 900],
			[400, 900]
		]
	],
	"existing_land_polygon": [
		[3100, 0],
		[3600, 0],
		[3600, 1450],
		[3100, 1450]
	],
	"existing_land_level_cd_m": 4.0,
	"shoreline_length_m": 9100,
	"structures": [
		{
			"id": "access_bund",
			"category": "pre_existing",
			"parts": [
				{
					"id": "trunk",
					"polygon": [
						[900, 260],
						[980, 260],
						[1080, 1600],
						[1000, 1600]
					],
					"crest_z_m": 4.8,
					"face_slope_key": "structure_face"
				}
			]
		}
	],
	"section_cuts": {
		"1-1": {
			"profile": "1-1",
			"line": [
				[300, -150],
				[300, 1600]
			]
		}
	}
}
```

`works_outline` is required and its absence throws. `seaward_edges` is a calibration requirement:
the reader provisionally takes the whole outline as water-facing so that the rest of the plan can
still be inspected, but the run is refused with the other shortfalls rather than priced on that
guess. For a wholly offshore site, state the entire outline there and the same reading becomes a
declared fact. Without `shoreline_length_m` the seaward edges are measured.

### Bathymetry

`x y z` or `x,y,z`, one sounding per line, header and comment lines skipped. DXF `POINT` entities
with a Z value work too, as does `{ "points": [[x, y, z], …] }`.

More than one survey can be supplied: attach the extras as `project_documents` with role
`additional_bathymetry`. Their soundings are pooled before gridding, so an infill survey densifies
the bed rather than replacing it — recorded as an assumption, because surveys flown at different
dates or datums are then averaged rather than sequenced.

Soundings are resampled onto a regular grid at the median sounding spacing. Cells receive the
mean of the points inside them; empty cells are filled from their eight neighbours over three
passes, then from the toe level. If the grid would exceed `maxCells` the spacing is coarsened and
a warning states the applied spacing.

The engine checks how much of the works outline the survey covers. Below 98% it warns; below 50%
it raises an error-severity warning, because partial coverage usually means the two documents are
not in the same frame.

### Cross sections

**DXF** is the primary form, and it is read as a plotted sheet rather than as a table of
coordinates. Several sections may share one page, each at its own scale and placed wherever it
fitted; `sheet.ts` groups the geometry into sections, attaches each section's own title, level
callouts, figured dimensions and slope notes, and calibrates that section from them before any of it
becomes station and elevation. The steps are:

1. group geometry into sections and attach each section's text;
2. fit `level = a·y + b` to the level callouts by consensus, not by averaging — a sheet is full of
   notes that mention a level without being one;
3. take the horizontal scale from a figured dimension where one is drawn, and otherwise from the
   vertical scale, which is correct whenever the plot is isotropic, with a warning when it is not;
4. put station zero on the toe; and
5. check the fitted geometry against every `1V:nH` callout on the sheet.

A section placed this way records a `sheet-calibration-<id>` assumption naming its plotting scale,
how many of its callouts agreed and to what residual. A drawing already authored in engineering
coordinates calibrates to the identity and reads back unchanged, so the two paths are one path.
Drafting furniture — level leaders, dimension lines, grids, borders and title blocks — is kept for
calibration but never read as profile.

**JSON** is the digitised path: `{ "profiles": { "1-1": [[station, z, "layer"], …] } }`, with
station and elevation already in metres on the project datum.

**CSV is refused.** A profile table is a transcription of a drawing, and the callouts, dimensions
and title text a sheet carries — the evidence the calibration rests on — are exactly what
transcribing discards. The error names the authored DXF as the thing to supply instead.

Extra section sheets attach as `project_documents` with role `additional_sections`. Their profiles
join the set, with ids kept unique. Every additional perimeter section replaces a stretch of
interpolation with measurement, which is why this is the most valuable thing a project can add.

#### Layer vocabulary

| Layer                                                                                                                                     | Meaning                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `toe`                                                                                                                                     | Seaward toe. Marks the profile as a perimeter section.                      |
| `quay_crest`, `caisson_landward`                                                                                                          | Vertical quay face. Also marks a perimeter section.                         |
| `hwm`                                                                                                                                     | High-water mark on the face.                                                |
| `crest_seaward`, `armor_crest`, `crest_landward`                                                                                          | Armour and bund crest limits.                                               |
| `platform`                                                                                                                                | Finished platform level.                                                    |
| `sea`, `interim`                                                                                                                          | Water level; fill material-change level.                                    |
| `*_face`                                                                                                                                  | Structure face. Supplies that structure's batter.                           |
| `*_crest`                                                                                                                                 | Structure crest, on a non-perimeter section.                                |
| `seabed`, `sand_key`, `bund_landward_toe`, `inner_fill`, `core`, `filter`, `bedding`, `soil_improvement_limit`, `geofabric`, `geotextile` | Below-grade or internal interfaces. Excluded from the finished top surface. |

A profile is a **perimeter** section only when it reaches the toe. A section drawn across an
internal bund describes that structure and is never wrapped around the perimeter. If _no_ section
names a toe, there is no basis to tell them apart: every section is taken as perimeter and the run
says so.

These keyword lists are defaults. Map a foreign vocabulary with `profileLayers` in the project
overrides, and check the result in the Model tab, which lists every layer the documents contained
and how it was read.

## The calibration gate

Four references decide whether the shape can be deduced at all. Missing any of them raises a
`CalibrationRequirement`, and `stitch()` throws before integration with every shortfall listed in
one message. Nothing is assumed in their place.

| Id                | Document      | Satisfied by                                                           |
| ----------------- | ------------- | ---------------------------------------------------------------------- |
| `seaward-edges`   | Floor plan    | A polyline on `TOE`/`QUAY`, or `seaward_edges`                         |
| `toe-marker`      | Cross section | A point on layer `toe`/`quay_crest`, or `profileLayers.toe`            |
| `platform-marker` | Cross section | A point on `platform`, `profileLayers.platform`, or `levelsM.platform` |
| `survey-coverage` | Bathymetry    | Soundings over at least 60% of the works outline                       |

The works outline is a fifth requirement in substance but not in mechanism: it fails immediately
rather than being collected, because the gate that reports the other four runs over a site that a
missing outline has not yet established. A DXF with no works layer falls back to the platform
polygon and records `outline-from-platform`; a plan with neither, and a plan JSON without
`works_outline`, throws.

Everything else degrades with a recorded assumption instead of failing, because an engineer needs
to see the shape before deciding whether the uncertainty matters. The line between the two is
exactly this: does the missing item change _where the works are_, or only _what they cost_?

## Sub-grade material bands

A section layer drawn below the finished surface is not merely excluded from the top surface — it
is read as a material band with its own invert polyline:

```json
{
	"profiles": {
		"1-1": [
			[-22, -17.5, "sand_key"],
			[-8, -17.5, "sand_key"],
			[0, -15.0, "toe"]
		]
	}
}
```

The first two stations are negative: that band reaches seaward of the toe.

`SUBGRADE_SUBSTRATE` maps the layer name onto a priced substrate (`sand_key`, `dredged_rock`,
`geofabric`), overridable with `profileLayers.subgrade`. At each cell the band is dug from
whichever surface is lower — the surveyed bed, or the design surface where the works already cut
down to it — to the invert. That volume is counted twice, deliberately and in different places:
once as **excavation** (material removed) and once as the **substrate** placed back into the
trench.

Because those stations are negative, the integration grid extends beyond the works outline by the
furthest seaward reach of any band. Station is signed: positive inside the outline, negative
seaward of it.

Bands are taken from the _nearest_ section rather than blended between two, so a trench invert is
never interpolated into existence between two sections that disagree about whether it exists.

Where a section draws no invert for a substrate, the analytic prism from the stated dimensions is
used instead, and its `basis` says so. The two are never added together.

## Derivation rules

| Quantity             | Rule                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Toe / platform level | Elevation of the `toe` and highest `platform` point.                                                                                                                                                   |
| Seaward face slope   | The profile segment leaving the toe. Not the chord across the face.                                                                                                                                    |
| Inner face slope     | `crest_landward` → `bund_landward_toe`.                                                                                                                                                                |
| Crest width          | Station of `crest_landward` − station of `crest_seaward`.                                                                                                                                              |
| Armour crest         | Station of `armor_crest` − station of `crest_seaward`.                                                                                                                                                 |
| Sand key             | Extent and depth of the `sand_key` points below the toe.                                                                                                                                               |
| Structure face slope | The bed-contact segment of a `*_face` layer on a non-perimeter section.                                                                                                                                |
| Structure crest      | Highest `*crest*` point on a non-perimeter section.                                                                                                                                                    |
| Face typology        | `caisson` when the section names a caisson/quay/wall layer, or when armour thickness is zero.                                                                                                          |
| Armour thickness     | Override → an `ARMOUR … 1.5 m` annotation → `t = 2B/3` from the armour crest width. Never defaulted: with none of those the armour and geofabric lines are zero and an error-severity warning says so. |

Layer lookup is exact, never substring: `crest_seaward` must not answer a request for `sea`.

## What generality means here

The engine holds no site dimension, no orientation, and no slope multiplier. Everything it knows
comes out of a document, and where a document is silent it records an assumption instead of
inventing a number. That claim is checked rather than asserted:

| Check                                | Result                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------- |
| Rotation 37° + 48 km translation     | Fill within **0.00%**, armour within **0.20%** of the untransformed run |
| Foreign section vocabulary           | Usable through `profileLayers`; classification reported back            |
| The same drawings left unmapped      | Refused, rather than read with the wrong layers                         |
| Comb of finger piers, three sections | Blended around the perimeter, `morph` active                            |
| 40 arbitrary star polygons           | 40 solids built, none refused without a reason, none crashed            |
| Uncalibrated drawings                | Refused, naming the toe, platform and seaward-edge shortfalls at once   |
| Integration cell 4 m → 2 m → 1 m     | Converges on the closed-form answer: 0.001% → 0.000%                    |
| Two sections plotted on one sheet    | Each recovers its own scale, 1:500 and 1:1000, from that one page       |

The rotation case is the important one. If any axis, chainage direction, or site dimension were
baked in, a rotated copy of the same site would price differently.

Two accuracy properties follow from the design rather than from tuning:

- **Convergence.** Cells straddling a zone limit are re-integrated on a 4×4 sub-grid, so the armour
  band — only a few cells wide — is not quantised to whole cells. Without that refinement the same
  rotation moves the armour by 5.8%.
- **Agreement.** The server integrator and the browser tessellator call the same sampler over the
  same persisted model, so the priced quantity and the drawn surface cannot drift.

## Project overrides

`reclamation_projects.stitch_overrides` is a JSON object that wins over every document:

```json
{
	"levelsM": { "toe": -15.0, "platform": 5.5, "interim": 0.0 },
	"slopes": { "seaward": "1V:3H", "structure_face": "1V:6H" },
	"dimensionsM": { "armorThickness": 1.5, "sandKeyWidth": 14, "sandKeyDepth": 2.5 },
	"seawardFaceKind": "revetment",
	"shorelineLengthM": 3072,
	"layerMapping": { "toe": ["TOE", "SEAWALL"] },
	"datum": "CD"
}
```

Invalid JSON is rejected at write time, before the row lands.

## Tuning

| Setting              | Default | Effect                                                             |
| -------------------- | ------- | ------------------------------------------------------------------ |
| `integration_cell_m` | 2.5 m   | Volume integration grid. Smaller is more exact and slower.         |
| `render_cell_m`      | 3 m     | Viewer tessellation grid. Smaller is more triangles, same shape.   |
| `interpolation`      | `morph` | `morph` blends between sections; `prismatic` snaps to the nearest. |
| `maxCells`           | 1.5 M   | Hard ceiling. Both grids coarsen rather than exceed it.            |

Both cells are clamped to 0.5–100 m at write time.
The requested size is therefore a target, not a promise: large sites are automatically coarsened
to the finest cell that fits the ceiling. The effective integration cell is persisted with the
reconstruction and shown beside the calculated volume.

## The assumption ledger

Every run records assumptions and warnings on `report_json`. An assumption states what was taken,
where it came from, and what the model looks like if it is wrong. A warning states a conflict or a
condition worth checking.

### Standing assumptions — recorded on every run

| Id                                 | Raised when           |
| ---------------------------------- | --------------------- |
| `single-metric-frame`              | Always                |
| `constant-seaward-batter`          | Always                |
| `station-is-distance-to-perimeter` | Always                |
| `platform-level-to-plan-limit`     | Always                |
| `bund-priced-as-sand`              | Always                |
| `prismatic-single-section`         | One perimeter section |
| `linear-morph-between-sections`    | Several, `morph` mode |
| `prismatic-between-sections`       | Several, `prismatic`  |
| `structure-linear-apron`           | Structures present    |
| `caisson-as-vertical-face`         | Vertical quay face    |
| `cut-not-filled`                   | Design below the bed  |

### Conditional assumptions

| Id                                    | Raised when                                                     |
| ------------------------------------- | --------------------------------------------------------------- |
| `sheet-calibration-<section>`         | A section was placed on the datum from its own level callouts   |
| `no-toe-label`                        | No section names a toe, so every section is read as perimeter   |
| `armor-thickness-from-crest-width`    | Thickness derived as `t = 2B/3` from the drawn armour crest     |
| `caisson-no-armor`                    | Vertical face, so no armour blanket                             |
| `no-dredged-rock`                     | No foundation-rock thickness stated                             |
| `no-hwm`                              | No `hwm` point on the section                                   |
| `sea-level-zero`                      | No `sea` point on the section                                   |
| `material-change-at-zero`             | No `interim` point on the section                               |
| `sand-key-trench`                     | Sand key read from the section, batter taken as 1V:2H           |
| `sub-grade-bands-dug-to-invert`       | Below-grade bands are dug against the surveyed bed              |
| `slope-from-annotation`               | Face slope came from a text callout                             |
| `structure-face-from-section`         | Structure batter derived from a `*_face` layer                  |
| `structure-crest-from-sections`       | Structure crest applied to every plan footprint                 |
| `levels-from-first-perimeter-section` | Several perimeter sections; the first governs levels            |
| `lagoon-carries-no-fill`              | Containment ponds on the plan                                   |
| `bathymetry-pooled`                   | More than one survey supplied; soundings pooled before gridding |
| `bathymetry-hole-fill`                | Cells interpolated in the survey                                |
| `outline-from-platform`               | No works-layer outline; platform polygon used instead           |
| `revetment-band-split`                | Two bands share the revetment layer                             |
| `unlabelled-section-cuts`             | Cut lines carry no `SEC x-x` label                              |

### Warnings

| Code                       | Meaning                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `frame-coverage`           | The survey does not cover the works outline                               |
| `design-below-bed`         | Part of the footprint is a cut, not a fill                                |
| `seaward-edge-off-outline` | A seaward-edge vertex is more than 1 m off the outline                    |
| `bathymetry-downsampled`   | Survey coarsened to stay under the cell ceiling                           |
| `plan-level-conflict`      | Plan annotation disagrees with the section sheet                          |
| `plan-units`               | `$INSUNITS` is not metres                                                 |
| `unmapped-plan-layers`     | Plan layers carrying geometry that the model ignored                      |
| `plan-entities-skipped`    | Undecoded DXF entity types                                                |
| `override-slope`           | An unparseable slope override was ignored                                 |
| `armor-thickness-unknown`  | Error severity: nothing on the sheet dimensions the armour, so it is zero |
| `sheet-<section>`          | A calibration note from the sheet reader about that one section           |

## When the stitch fails

The reconstruction throws only when a document cannot be read at all — no perimeter section, no
readable soundings, no closed outline, an unresolvable face slope, an unsupported format. Anything
merely uncertain becomes an assumption or a warning and the model is still produced, because an
engineer needs to see the shape before deciding whether the uncertainty matters.

A failed run is still recorded, as a `site_reconstructions` row with `status: 'failed'` and the
reason, so the failure is visible in the project panel rather than lost.

## What the model does not do

- No georeferencing, projection, or datum transform. Both documents are _assumed_ to share the
  project datum; the survey-coverage and `design-below-bed` checks are what surface a mismatch.
- Internal layering _within_ a pre-existing structure is not modelled: a structure is its
  footprint at crest level with one straight face batter.
- Context polygons are drawn flat at platform level; they are never integrated or priced.
- No dredging quantity is priced; excavation is reported only.
- No concrete, caisson, or founding-trench volume for a vertical quay.
- Sand key and dredged rock are prisms from the section dimensions, not meshed solids.
- Section cuts are drawn as polylines on the surface; the sheets themselves are not rendered.
- Containment ponds are read as flat water, not as staged fill.
