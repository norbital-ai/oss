/**
 * Shared reclamation-engine types.
 *
 * Every value here is JSON-safe: the same structures are produced by the server
 * stitch hook, persisted on `site_reconstructions`, and replayed by the browser
 * viewer worker. Server and browser therefore build the *same* geometry from the
 * *same* numbers — a quantity shown in the cost panel always describes the solid
 * drawn on screen.
 *
 * Frame convention: metres in one local frame shared by all three documents.
 * X and Y are plan coordinates and Z is elevation on the project datum. The
 * engine never georeferences and applies no projection.
 *
 * Profile station convention: station 0 sits on the seaward perimeter and
 * increases inward, measured as the shortest distance to the nearest seaward
 * edge. That holds for a straight coast, a curved shoreline, and a finger pier
 * with water on three sides alike.
 */

export type Point2 = readonly [number, number];

/** Slope expressed as vertical:horizontal, e.g. `1V:3H` → `{ v: 1, h: 3 }`. */
export type SlopeRatio = { readonly v: number; readonly h: number };

/** Outer perimeter typology. Drives whether a rock armour blanket exists. */
export type SeawardFaceKind = 'revetment' | 'caisson';

/** How geometry is carried between two section cuts. */
export type InterpolationMode = 'morph' | 'prismatic';

/** Where a structure sits in the works timeline. */
export type StructureCategory = 'pre_existing' | 'new_works';

export type DocumentKind = 'floor_plan' | 'bathymetry' | 'cross_section';

export type DocumentFormat = 'dwg' | 'dxf' | 'pdf' | 'xyz' | 'csv' | 'json' | 'unsupported';

/** One point on a section polyline: `(station, z, layer)`. */
export type ProfilePoint = {
	readonly stationM: number;
	readonly zCdM: number;
	readonly layer: string;
	/** Source CAD entity. Points with the same id belong to one authored segment. */
	readonly segmentId?: string;
};

/** Regular height field sampled from the bathymetric / topographic survey. */
export type SeabedGrid = {
	readonly x0: number;
	readonly y0: number;
	readonly dx: number;
	readonly dy: number;
	readonly nx: number;
	readonly ny: number;
	/** Row-major, length `nx * ny`, indexed `z[iy * nx + ix]`. */
	readonly z: readonly number[];
};

/** Levels, slopes, and dimensions read off the section sheet. */
export type SectionParameters = {
	readonly levelsM: {
		readonly toe: number;
		readonly platform: number;
		readonly hwm?: number;
		readonly sea: number;
		/** Material-change level; below it fill is dredged/excavated, above it sand. */
		readonly interim?: number;
	};
	/** Canonical keys: `seaward`, `inner_fill`, `sand_key`, plus any authored key. */
	readonly slopes: Readonly<Record<string, SlopeRatio>>;
	readonly dimensionsM: {
		readonly crestWidth?: number;
		readonly armorCrest?: number;
		readonly armorThickness: number;
		readonly dredgedRockThickness?: number;
		readonly sandKeyWidth?: number;
		readonly sandKeyDepth?: number;
		readonly caissonWidth?: number;
	};
	readonly seawardFaceKind: SeawardFaceKind;
	readonly materials?: readonly string[];
};

/** One embankment element (T-bund trunk, mole, access bund). */
export type PlanStructurePart = {
	readonly id: string;
	/** Crest footprint in plan metres. */
	readonly polygon: readonly Point2[];
	readonly crestZM: number;
	/** Slope key resolved against `SectionParameters.slopes`. */
	readonly faceSlopeKey: string;
	readonly faceSlopeKeySeaward?: string;
};

export type PlanStructure = {
	readonly id: string;
	readonly category: StructureCategory;
	readonly parts: readonly PlanStructurePart[];
};

export type PlanSectionCut = {
	readonly id: string;
	readonly profileId: string;
	readonly line: readonly Point2[];
	readonly type?: string;
	/** Alongshore station of the cut, used to order and blend profiles. */
	readonly chainageM: number;
};

/** How each section layer was read, and which sections govern the perimeter. */
export type ProfileClassificationSnapshot = {
	readonly perimeterIds: readonly string[];
	readonly explicit: boolean;
	readonly layers: readonly { readonly layer: string; readonly role: 'surface' | 'internal' }[];
	readonly layerOverrides?: {
		readonly surface?: readonly string[];
		readonly internal?: readonly string[];
		readonly toe?: readonly string[];
	};
};

/** Plan geometry read off the floor plan / site key plan. */
export type PlanGeometry = {
	/** Total length of the seaward perimeter — quay face, revetment, or both. */
	readonly shorelineLengthM: number;
	/**
	 * Closed outline of the works at the toe. Any shape: a coastal strip, a
	 * curved shoreline, or a comb of finger piers with basins between them.
	 */
	readonly worksOutline: readonly Point2[];
	/**
	 * The outline edges that face water and therefore carry the perimeter
	 * section. Edges left out (a boundary against existing land, a phase joint)
	 * get no face, and cells near them read as platform.
	 */
	readonly seawardEdges: readonly (readonly Point2[])[];
	readonly platformTopPolygon: readonly Point2[];
	readonly crestPolygon?: readonly Point2[];
	readonly armorPolygon?: readonly Point2[];
	/**
	 * Containment ponds inside the bund that carry no fill — the open water seen
	 * inside a hydraulic-fill perimeter while the pad is still being raised.
	 */
	readonly lagoonPolygons?: readonly (readonly Point2[])[];
	/**
	 * Neighbouring or future works drawn for context — adjacent phases, an
	 * adjoining terminal. Rendered so the site reads in its setting; never
	 * integrated, never priced.
	 */
	readonly contextPolygons?: readonly {
		readonly label: string;
		readonly polygon: readonly Point2[];
	}[];
	readonly existingShoreline?: readonly Point2[];
	readonly existingLandPolygon?: readonly Point2[];
	readonly existingLandLevelM?: number;
	readonly structures: readonly PlanStructure[];
	readonly sectionCuts: readonly PlanSectionCut[];
};

/** Everything read out of the three documents, before normalisation. */
export type SiteData = {
	readonly params: SectionParameters;
	readonly plan: PlanGeometry;
	readonly profiles: Readonly<Record<string, readonly ProfilePoint[]>>;
	readonly seabed: SeabedGrid;
};

/** Reason a number in the model is not directly measured from a document. */
export type StitchAssumption = {
	readonly id: string;
	readonly title: string;
	readonly detail: string;
	/** What the model would look like if the assumption is wrong. */
	readonly effect: string;
	readonly source: DocumentKind | 'default' | 'override';
};

export type StitchWarningSeverity = 'info' | 'warning' | 'error';

export type StitchWarning = {
	readonly code: string;
	readonly message: string;
	readonly severity: StitchWarningSeverity;
};

export type DocumentProvenance = {
	readonly kind: DocumentKind;
	readonly assetId: string | null;
	readonly fileName: string | null;
	readonly format: DocumentFormat;
	readonly byteSize: number;
	readonly sha256: string;
	readonly summary: string;
};

/** Tuning knobs the project owner controls; every field has a documented default. */
export type StitchSettings = {
	/** Plan cell size for volume integration (m). Smaller = more exact, slower. */
	readonly integrationCellM: number;
	/** Plan cell size for the rendered surfaces (m). */
	readonly renderCellM: number;
	readonly interpolation: InterpolationMode;
	/** Hard ceiling on integration cells, protecting the hook's runtime. */
	readonly maxCells: number;
	/** Vertex budget for the surveyed bed. Above it, the survey is stepped down. */
	readonly maxSeabedVertices?: number;
};

/**
 * The canonical, normalised model. This is what is persisted and what both the
 * volume integrator and the viewer consume.
 */
export type StitchedModel = {
	readonly datum: string;
	readonly params: SectionParameters;
	readonly plan: PlanGeometry;
	readonly profiles: Readonly<Record<string, readonly ProfilePoint[]>>;
	readonly seabed: SeabedGrid;
	readonly settings: StitchSettings;
	/** Resolved section classification, so the browser samples exactly as the server did. */
	readonly classification: ProfileClassificationSnapshot;
	/** Plan-space bounds of everything that will be drawn. */
	readonly bounds: {
		readonly minX: number;
		readonly maxX: number;
		readonly minY: number;
		readonly maxY: number;
		readonly minZ: number;
		readonly maxZ: number;
	};
};

/** Substrates priced by the cost matrix. */
export type SubstrateId =
	'rock_armor' | 'geofabric' | 'dredged_rock' | 'sand_key' | 'sand_fill' | 'dredged_fill' | 'pvd';

export type QuantityUnit = 'm3' | 'm2' | 'm';

export type SubstrateQuantity = {
	readonly substrate: SubstrateId;
	readonly unit: QuantityUnit;
	readonly quantity: number;
	/** How the number was obtained, quoted verbatim in the UI and exports. */
	readonly basis: string;
	/** `integrated` = summed from the stitched solid; `analytic` = prism formula. */
	readonly method: 'integrated' | 'analytic';
};

export type ReconstructionMetrics = {
	readonly platformAreaM2: number;
	readonly worksFootprintM2: number;
	readonly armorFaceAreaM2: number;
	readonly shorelineLengthM: number;
	readonly meanFillDepthM: number;
	readonly maxFillDepthM: number;
	readonly integratedCells: number;
	readonly integrationCellM: number;
	/** Volume of pre-existing structure standing inside the works envelope. */
	readonly structureDisplacementM3: number;
	/** Volume where the design surface lies below the surveyed bed (a cut). */
	readonly excavationM3: number;
	/**
	 * Volume dug to reach a trench invert the section draws — a sand key or a
	 * rock foundation. Specified work, reported apart from an unexplained cut.
	 */
	readonly trenchExcavationM3: number;
	/**
	 * Total material placed. The integrated substrate lines sum to exactly this,
	 * so a take-off can be reconciled without multiplying rounded metrics.
	 */
	readonly placedVolumeM3: number;
};

export type StitchReport = {
	readonly assumptions: readonly StitchAssumption[];
	/** How every section layer the documents contained was read. */
	readonly layerClassification?: readonly {
		readonly layer: string;
		readonly role: 'surface' | 'internal';
	}[];
	readonly warnings: readonly StitchWarning[];
	readonly documents: readonly DocumentProvenance[];
	readonly engineVersion: string;
};

/** Full result of a stitch run — persisted on `site_reconstructions`. */
export type StitchResult = {
	readonly model: StitchedModel;
	readonly quantities: readonly SubstrateQuantity[];
	readonly metrics: ReconstructionMetrics;
	readonly report: StitchReport;
};

/** Render material bucket. One indexed mesh is produced per bucket. */
export type SurfaceId =
	| 'seabed'
	| 'sea'
	| 'armor'
	| 'crest'
	| 'platform'
	| 'skirt'
	| 'structure'
	| 'lagoon'
	| 'existing_land'
	| 'context'
	/** Below-seabed trenches: the ground dug out before any fill is placed. */
	| 'subgrade';

/** THREE-free mesh payload. Transferred from the worker, wrapped by the viewer. */
export type SurfaceMesh = {
	readonly id: SurfaceId;
	readonly label: string;
	readonly color: number;
	readonly opacity: number;
	readonly doubleSided: boolean;
	readonly positions: Float32Array;
	readonly normals: Float32Array;
	readonly indices: Uint32Array;
};

export type SectionCutLine = {
	readonly id: string;
	readonly label: string;
	/** Flat `x,y,z` triples in plan/elevation space. */
	readonly points: Float32Array;
};

export type SiteSurfaces = {
	readonly meshes: readonly SurfaceMesh[];
	readonly cuts: readonly SectionCutLine[];
	readonly bounds: StitchedModel['bounds'];
	readonly renderCellM: number;
	readonly vertexCount: number;
	readonly triangleCount: number;
};
