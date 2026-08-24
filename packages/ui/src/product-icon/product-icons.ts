import { Schema } from 'effect';

export const PRODUCT_LAYER_ICON_NAMES = ['model', 'security', 'logic', 'interface'] as const;

export const PRODUCT_SUBMODULE_ICON_NAMES = [
	'models',
	'relations',
	'policies',
	'approvals',
	'audit',
	'hooks',
	'pipelines',
	'integrations',
	'automations',
	'remotes',
	'apps',
	'agent'
] as const;

export const PRODUCT_ICON_NAMES = [
	'bolt',
	'colony',
	...PRODUCT_LAYER_ICON_NAMES,
	...PRODUCT_SUBMODULE_ICON_NAMES,
	'collections',
	'studio',
	'environment',
	'organization',
	'documentation',
	'quick-start',
	'concepts',
	'api',
	'deployment',
	'examples'
] as const;

export type ProductIconName = (typeof PRODUCT_ICON_NAMES)[number];
export type ProductLayerIconName = (typeof PRODUCT_LAYER_ICON_NAMES)[number];
export type ProductSubmoduleIconName = (typeof PRODUCT_SUBMODULE_ICON_NAMES)[number];
export type ProductIconReference = `product:${ProductIconName}`;

const ProductIconPrimitiveSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal('path'),
		d: Schema.String,
		accent: Schema.optional(Schema.Literal(true))
	}),
	Schema.Struct({
		kind: Schema.Literal('ellipse'),
		cx: Schema.Number,
		cy: Schema.Number,
		rx: Schema.Number,
		ry: Schema.Number,
		accent: Schema.optional(Schema.Literal(true))
	}),
	Schema.Struct({
		kind: Schema.Literal('circle'),
		cx: Schema.Number,
		cy: Schema.Number,
		r: Schema.Number,
		accent: Schema.optional(Schema.Literal(true))
	}),
	Schema.Struct({
		kind: Schema.Literal('rect'),
		x: Schema.Number,
		y: Schema.Number,
		width: Schema.Number,
		height: Schema.Number,
		rx: Schema.Number,
		accent: Schema.optional(Schema.Literal(true))
	})
]);
export type ProductIconPrimitive = typeof ProductIconPrimitiveSchema.Type;

/** Canonical layer geometry shared by SVG icons and procedural product illustrations. */
export const PRODUCT_LAYER_ICON_GEOMETRY = {
	model: [
		{ kind: 'ellipse', cx: 12, cy: 5, rx: 9, ry: 3 },
		{ kind: 'path', d: 'M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5' },
		{ kind: 'path', d: 'M3 12c0 1.7 4 3 9 3s9-1.3 9-3' },
		{ kind: 'path', d: 'M3 5v4', accent: true }
	],
	security: [
		{ kind: 'path', d: 'M12 3 19 6v5c0 4.5-2.7 7.6-7 10-4.3-2.4-7-5.5-7-10V6l7-3Z' },
		{ kind: 'path', d: 'm9.5 12 1.7 1.7 3.5-3.7', accent: true }
	],
	logic: [
		{ kind: 'path', d: 'M16 3h5v5M4 20l6-6M14 10l7-7M4 4l5 5M15 15l6 6M21 16v5h-5' },
		{ kind: 'path', d: 'm10 14 4-4', accent: true }
	],
	interface: [
		{ kind: 'rect', x: 2, y: 5, width: 10, height: 14, rx: 2 },
		{ kind: 'circle', cx: 18, cy: 12, r: 3 },
		{ kind: 'path', d: 'M12 12h3', accent: true }
	]
} as const satisfies Record<ProductLayerIconName, readonly ProductIconPrimitive[]>;

const productLayerIconGeometryByName = new Map<string, readonly ProductIconPrimitive[]>(
	PRODUCT_LAYER_ICON_NAMES.map<[string, readonly ProductIconPrimitive[]]>((name) => [
		name,
		PRODUCT_LAYER_ICON_GEOMETRY[name]
	])
);

const productIconNameByReference = new Map<string, ProductIconName>(
	PRODUCT_ICON_NAMES.map<[string, ProductIconName]>((name) => [name, name])
);

export function productLayerIconGeometry(
	name: ProductIconName
): readonly ProductIconPrimitive[] | null {
	return productLayerIconGeometryByName.get(name) ?? null;
}

export function productIconNameFromReference(
	reference: string | null | undefined
): ProductIconName | null {
	if (!reference?.startsWith('product:')) return null;
	return productIconNameByReference.get(reference.slice('product:'.length)) ?? null;
}

export function productIconReference(name: ProductIconName): ProductIconReference {
	return `product:${name}`;
}
