/** Public surface of the reclamation engine. */

export { parseDxf, entitiesOnLayer, readLevelAnnotation, readSlopeAnnotation } from './dxf.js';
export type { DxfDocument, DxfEntity, DxfEntityType } from './dxf.js';

export { DEFAULT_LAYER_MAPPING, Ledger, detectFormat, extractSiteData } from './extract.js';
export type { ExtractionResult, LayerMapping, RawDocument, StitchOverrides } from './extract.js';

export {
	CAISSON_PROFILE_LAYERS,
	NON_SURFACE_PROFILE_LAYERS,
	isPerimeterProfile,
	isSurfaceLayer
} from './profile-layers.js';

export {
	boundingBox,
	clamp,
	formatSlopeRatio,
	horizontalRun,
	parseSlopeRatio,
	pointInPolygon,
	polygonArea,
	polylineLength,
	round,
	sampleSeabed,
	sampleYAlongX,
	slantLength,
	verticalRise,
	verticalThicknessOnSlope
} from './math.js';

export {
	coercePolygon,
	decodeText,
	griddedSurveyFromPoints,
	parseJson,
	parseXyz
} from './parse.js';

export { ENGINE_VERSION, buildSurfaces, integrateSite } from './solids.js';

export {
	buildPerimeterField,
	buildPerimeterIndex,
	createSampler,
	nearestPerimeter,
	samplePerimeter,
	sampleTopSurface,
	topSurfaceFromProfile
} from './surface.js';
export type {
	PerimeterField,
	PerimeterHit,
	PerimeterIndex,
	SiteSampler,
	TopSurface,
	ZoneId
} from './surface.js';

export { DEFAULT_STITCH_SETTINGS, stitch } from './stitch.js';
export type { StitchInput } from './stitch.js';

export {
	DEFAULT_LEVERS,
	SUBSTRATES,
	buildEstimate,
	formatMoney,
	formatQuantity,
	pvdLength,
	substrateDefinition
} from './cost.js';
export type {
	CostEstimateResult,
	CostLevers,
	CostLine,
	RateRow,
	SubstrateDefinition
} from './cost.js';

export type * from './types.js';
