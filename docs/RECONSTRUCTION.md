# How the stitch works

The reference for the reconstruction: what each document must contain, the rules applied to it,
and every assumption the engine can record. The [workspace README](../README.md) is the summary;
this is the detail an engineer needs before trusting a volume.

## Where the code lives

| Concern                                     | Module                                                   |
| ------------------------------------------- | -------------------------------------------------------- |
| Slope, run, area, sampling primitives       | `src/lib/reclamation/math.ts`                            |
| DXF group-code reader                       | `src/lib/reclamation/dxf.ts`                             |
| XYZ / CSV / JSON decoders and gridding      | `src/lib/reclamation/parse.ts`                           |
| Section layer vocabulary                    | `src/lib/reclamation/profile-layers.ts`                  |
| Document interpretation, layer mapping      | `src/lib/reclamation/extract.ts`                         |
| Perimeter sampler, section blending         | `src/lib/reclamation/surface.ts`                         |
| Volume integration and tessellation         | `src/lib/reclamation/solids.ts`                          |
| Pipeline and the standing assumption ledger | `src/lib/reclamation/stitch.ts`                          |
| Levers, rates, money                        | `src/lib/reclamation/cost.ts`                            |
| Server driver (read assets, record a run)   | `src/collections/reclamation_projects/lib/run-stitch.ts` |
| The hook itself                             | `src/collections/reclamation_projects/+hooks.ts`         |

The engine has no framework, DOM, or Node dependency. `stitch()` is bytes in, JSON out, which is
why the same modules run in the server hook and in the browser tessellation worker.

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

`works_outline` is required. Without `seaward_edges` the whole outline is treated as
water-facing, which is recorded as an assumption. Without `shoreline_length_m` the seaward edges
are measured.

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

CSV is the primary form:

```csv
profile,station_m,z_cd_m,layer
1-1,-22,-17.5,sand_key
1-1,0,-15.0,toe
1-1,52.545,2.515,hwm
1-1,61.5,5.5,crest_seaward
1-1,63.0,5.5,armor_crest
1-1,83.0,5.5,crest_landward
1-1,144.0,-15.0,bund_landward_toe
1-1,420,5.5,platform
```

The `profile` column is optional; without it every row belongs to one section. Column names
`station_m`/`station`, `z_cd_m`/`z_m`/`z`, and `layer`/`material` are all accepted.

JSON is `{ "profiles": { "1-1": [[station, z, "layer"], …] } }`. A DXF section sheet works when
each section is on its own layer and drawn in station/elevation space.

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

Five references decide whether the shape can be deduced at all. Missing any of them raises a
`CalibrationRequirement`, and `stitch()` throws before integration with every shortfall listed in
one message. Nothing is assumed in their place.

| Id                | Document      | Satisfied by                                                           |
| ----------------- | ------------- | ---------------------------------------------------------------------- |
| `works-outline`   | Floor plan    | A closed polyline on a works layer, or `works_outline`                 |
| `seaward-edges`   | Floor plan    | A polyline on `TOE`/`QUAY`, or `seaward_edges`                         |
| `toe-marker`      | Cross section | A point on layer `toe`/`quay_crest`, or `profileLayers.toe`            |
| `platform-marker` | Cross section | A point on `platform`, `profileLayers.platform`, or `levelsM.platform` |
| `survey-coverage` | Bathymetry    | Soundings over at least 60% of the works outline                       |

Everything else degrades with a recorded assumption instead of failing, because an engineer needs
to see the shape before deciding whether the uncertainty matters. The line between the two is
exactly this: does the missing item change _where the works are_, or only _what they cost_?

## Sub-grade material bands

A section layer drawn below the finished surface is not merely excluded from the top surface — it
is read as a material band with its own invert polyline:

```csv
1-1,-22,-17.5,sand_key      ← station is negative: seaward of the toe
1-1,-8,-17.5,sand_key
1-1,0,-15.0,toe
```

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

| Quantity             | Rule                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Toe / platform level | Elevation of the `toe` and highest `platform` point.                                                             |
| Seaward face slope   | The profile segment leaving the toe. Not the chord across the face.                                              |
| Inner face slope     | `crest_landward` → `bund_landward_toe`.                                                                          |
| Crest width          | Station of `crest_landward` − station of `crest_seaward`.                                                        |
| Armour crest         | Station of `armor_crest` − station of `crest_seaward`.                                                           |
| Sand key             | Extent and depth of the `sand_key` points below the toe.                                                         |
| Structure face slope | The bed-contact segment of a `*_face` layer on a non-perimeter section.                                          |
| Structure crest      | Highest `*crest*` point on a non-perimeter section.                                                              |
| Face typology        | `caisson` when the section names a caisson/quay/wall layer, or when armour thickness is zero.                    |
| Armour thickness     | Override → an `ARMOUR … 1.5 m` annotation → the Detail-A crest width → 1.00 m. Always recorded as an assumption. |

Layer lookup is exact, never substring: `crest_seaward` must not answer a request for `sea`.

## What generality means here

The engine holds no site dimension, no orientation, and no slope multiplier. Everything it knows
comes out of a document, and where a document is silent it records an assumption instead of
inventing a number. That claim is checked rather than asserted:

| Check                                           | Result                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| Circular island, sections labelled only `grade` | Solid built; `no-toe-label` assumption raised                          |
| Rotation 37° + 48 km translation                | Fill within **0.01%**, armour within **1.3%** of the untransformed run |
| Foreign section vocabulary                      | Usable through `profileLayers`; classification reported back           |
| Comb of finger piers, three sections            | Blended around the perimeter, `morph` active                           |
| 40 arbitrary star polygons                      | 40 solids built, none crashed                                          |
| Integration cell 5.0 m → 1.5 m                  | Volume moves **0.00%**                                                 |

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

| Id                                    | Raised when                                            |
| ------------------------------------- | ------------------------------------------------------ |
| `armor-thickness-assumed`             | No thickness stated on the section or in overrides     |
| `caisson-no-armor`                    | Vertical face, so no armour blanket                    |
| `no-dredged-rock`                     | No foundation-rock thickness stated                    |
| `no-hwm`                              | No `hwm` point on the section                          |
| `sea-level-zero`                      | No `sea` point on the section                          |
| `material-change-at-zero`             | No `interim` point on the section                      |
| `sand-key-trench`                     | Sand key read from the section, batter taken as 1V:2H  |
| `slope-from-annotation`               | Face slope came from a text callout                    |
| `structure-face-from-section`         | Structure batter derived from a `*_face` layer         |
| `structure-crest-from-sections`       | Structure crest applied to every plan footprint        |
| `levels-from-first-perimeter-section` | Several perimeter sections; the first governs levels   |
| `lagoon-carries-no-fill`              | Containment ponds on the plan                          |
| `bathymetry-hole-fill`                | Cells interpolated in the survey                       |
| `outline-from-platform`               | No works-layer outline; platform polygon used instead  |
| `whole-outline-is-seaward`            | No toe/quay layer; the section wraps the whole outline |
| `revetment-band-split`                | Two bands share the revetment layer                    |
| `section-dxf-layer-per-profile`       | Sections supplied as a DXF                             |
| `unlabelled-section-cuts`             | Cut lines carry no `SEC x-x` label                     |

### Warnings

| Code                       | Meaning                                                |
| -------------------------- | ------------------------------------------------------ |
| `frame-coverage`           | The survey does not cover the works outline            |
| `design-below-bed`         | Part of the footprint is a cut, not a fill             |
| `seaward-edge-off-outline` | A seaward-edge vertex is more than 1 m off the outline |
| `bathymetry-downsampled`   | Survey coarsened to stay under the cell ceiling        |
| `plan-level-conflict`      | Plan annotation disagrees with the section sheet       |
| `plan-units`               | `$INSUNITS` is not metres                              |
| `unmapped-plan-layers`     | Plan layers carrying geometry that the model ignored   |
| `plan-entities-skipped`    | Undecoded DXF entity types                             |
| `override-slope`           | An unparseable slope override was ignored              |

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
