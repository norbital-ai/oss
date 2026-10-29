import { Array as Arr, Predicate, Schema } from 'effect';
import type { Json, Kind } from './kind.js';

/**
 * JSON Schema is data, never executable code. Remote references are deliberately not fetched. Every keyword this
 * renderer reads is typed; any other keyword is carried as JSON (`$defs`, vendor keywords) for `$ref` resolution.
 */
export type JsonSchema = boolean | JsonSchemaObject;
type JsonSchemaObject = {
	readonly [keyword: string]: Json | JsonSchema | readonly JsonSchema[] | undefined;
	readonly $schema?: string;
	readonly $ref?: string;
	readonly type?: string | readonly string[];
	readonly format?: string;
	readonly title?: string;
	readonly description?: string;
	readonly unit?: string;
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly additionalProperties?: JsonSchema;
	readonly required?: readonly string[];
	readonly items?: JsonSchema;
	readonly prefixItems?: readonly JsonSchema[];
	readonly allOf?: readonly JsonSchema[];
	readonly anyOf?: readonly JsonSchema[];
	readonly oneOf?: readonly JsonSchema[];
	readonly if?: JsonSchema;
	readonly then?: JsonSchema;
	readonly else?: JsonSchema;
	readonly not?: JsonSchema;
	readonly enum?: readonly Json[];
	readonly const?: Json;
	readonly default?: Json;
	readonly readOnly?: boolean;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly exclusiveMinimum?: number;
	readonly exclusiveMaximum?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly minProperties?: number;
	readonly maxProperties?: number;
	readonly 'x-norbital'?: {
		readonly datatype?: string;
		readonly section?: string;
		readonly advanced?: boolean;
		readonly order?: number;
	};
};

const optional = Schema.optionalKey;
const Node: Schema.Codec<JsonSchema> = Schema.Union([
	Schema.Boolean,
	Schema.StructWithRest(
		Schema.Struct({
			$schema: optional(Schema.String),
			$ref: optional(Schema.String),
			type: optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
			format: optional(Schema.String),
			title: optional(Schema.String),
			description: optional(Schema.String),
			unit: optional(Schema.String),
			properties: optional(
				Schema.Record(
					Schema.String,
					Schema.suspend(() => Node)
				)
			),
			additionalProperties: optional(Schema.suspend(() => Node)),
			required: optional(Schema.Array(Schema.String)),
			items: optional(Schema.suspend(() => Node)),
			prefixItems: optional(Schema.Array(Schema.suspend(() => Node))),
			allOf: optional(Schema.Array(Schema.suspend(() => Node))),
			anyOf: optional(Schema.Array(Schema.suspend(() => Node))),
			oneOf: optional(Schema.Array(Schema.suspend(() => Node))),
			if: optional(Schema.suspend(() => Node)),
			then: optional(Schema.suspend(() => Node)),
			else: optional(Schema.suspend(() => Node)),
			not: optional(Schema.suspend(() => Node)),
			enum: optional(Schema.Array(Schema.Json)),
			const: optional(Schema.Json),
			default: optional(Schema.Json),
			readOnly: optional(Schema.Boolean),
			minimum: optional(Schema.Number),
			maximum: optional(Schema.Number),
			exclusiveMinimum: optional(Schema.Number),
			exclusiveMaximum: optional(Schema.Number),
			minLength: optional(Schema.Number),
			maxLength: optional(Schema.Number),
			minItems: optional(Schema.Number),
			maxItems: optional(Schema.Number),
			minProperties: optional(Schema.Number),
			maxProperties: optional(Schema.Number),
			'x-norbital': optional(
				Schema.Struct({
					datatype: optional(Schema.String),
					section: optional(Schema.String),
					advanced: optional(Schema.Boolean),
					order: optional(Schema.Number)
				})
			)
		}),
		[Schema.Record(Schema.String, Schema.Json)]
	)
]);

/** Whether a stored value is a JSON Schema in the keywords this renderer reads: decode once where a schema enters a page. */
export const isJsonSchema: (value: unknown) => value is JsonSchema = Schema.is(Node);

/** A JSON Schema document: an object naming its dialect in `$schema`, the keyword by which a value says it is a schema. */
export const isJsonSchemaDocument = (value: unknown): value is Exclude<JsonSchema, boolean> =>
	isJsonSchema(value) && typeof value !== 'boolean' && value.$schema !== undefined;

const COMPOSITIONS = [
	'allOf',
	'anyOf',
	'oneOf',
	'if',
	'then',
	'else',
	'not',
	'dependentSchemas',
	'patternProperties',
	'prefixItems'
] as const;
/** A conditional whose arms only add `required` keys: it changes no control, only what a validator demands. */
const requiresOnly = (part: JsonSchema) => {
	if (typeof part === 'boolean') return false;
	const { if: _when, then, else: otherwise, ...rest } = part;
	return (
		Object.values(rest).every((keyword) => keyword === undefined) &&
		[then, otherwise].every(
			(arm) =>
				arm === undefined ||
				(typeof arm !== 'boolean' && Object.keys(arm).every((keyword) => keyword === 'required'))
		)
	);
};
/**
 * Whether a schema composes others in a way that changes its shape. Conditionals (top-level or in `allOf`) that only
 * require keys do not: the base object renders and the caller's validator enforces them.
 */
export function composesJsonSchema(schema: Exclude<JsonSchema, boolean>): boolean {
	const { if: when, then, else: otherwise, allOf, ...rest } = schema;
	if (COMPOSITIONS.some((keyword) => keyword in rest)) return true;
	const conditionals: JsonSchema[] = [
		...(when === undefined && then === undefined && otherwise === undefined
			? []
			: [{ if: when, then, else: otherwise }]),
		...(allOf ?? [])
	];
	return !conditionals.every(requiresOnly);
}

/** Whether a node's `type` admits `null`, so clearing it writes null instead of removing the key. */
export const nullableJsonSchema = (schema: JsonSchema) =>
	typeof schema !== 'boolean' &&
	(schema.type === 'null' || (Arr.isArray(schema.type) && schema.type.includes('null')));

type Pointed = Json | JsonSchema | readonly JsonSchema[] | undefined;
/** One JSON Pointer step through the decoded document: a member or an index, else nothing. */
const step = (at: Pointed, key: string): Pointed =>
	at === null || typeof at !== 'object' || !Object.hasOwn(at, key)
		? undefined
		: Arr.isArray<Pointed>(at)
			? at[Number(key)]
			: at[key];

/** Resolve local JSON Pointers, with cycle detection. Unsupported references keep their JSON editor. */
export function resolveJsonSchema(schema: JsonSchema, root: JsonSchema = schema): JsonSchema {
	const seen = new Set<string>();
	while (typeof schema !== 'boolean' && schema.$ref !== undefined) {
		const ref = schema.$ref;
		if (!ref.startsWith('#/') || seen.has(ref)) return true;
		seen.add(ref);
		const target = ref
			.slice(2)
			.split('/')
			.reduce((at: Pointed, part) => step(at, part.replace(/~1/g, '/').replace(/~0/g, '~')), root);
		// a pointer may land under any keyword, `$defs` included: what it names is decoded there
		if (!isJsonSchema(target)) return true;
		const { $ref: _ref, ...siblings } = schema;
		// Sibling assertions are intersections, not overrides. Keep ambiguous intersections in JSON.
		if (typeof target === 'boolean') return Object.keys(siblings).length === 0 ? target : true;
		const resolved = target;
		if (
			Object.keys(siblings).some(
				(key) => key in resolved && !['title', 'description', 'x-norbital'].includes(key)
			)
		)
			return true;
		schema = { ...resolved, ...siblings };
	}
	return schema;
}

const isTextFormat = Schema.is(Schema.Literals(['email', 'url', 'phone', 'zone', 'markdown']));
/** A conservative rendering plan. Validation remains the caller/server's JSON Schema validator. */
export function jsonSchemaKind(schema: JsonSchema): Kind {
	if (typeof schema === 'boolean') return { kind: 'json' };
	const common = { label: schema.title, help: schema.description };
	if (composesJsonSchema(schema)) return { ...common, kind: 'json' };
	if (schema['x-norbital']?.datatype)
		return { ...common, kind: 'custom', of: schema['x-norbital'].datatype };
	const values = schema.enum;
	if (values?.every(Predicate.isString)) return { ...common, kind: 'enum', values };
	const type = Arr.isArray(schema.type) ? schema.type.filter((t) => t !== 'null') : [schema.type];
	if (type.length !== 1) return { ...common, kind: 'json' };
	switch (type[0]) {
		case 'object':
			return { ...common, kind: 'object', fields: {} };
		case 'array':
			return schema.items === undefined
				? { ...common, kind: 'json' }
				: {
						...common,
						kind: 'list',
						of: { kind: 'json' },
						min: schema.minItems,
						max: schema.maxItems
					};
		case 'boolean':
			return { ...common, kind: 'bool' };
		case 'integer':
		case 'number':
			return {
				...common,
				kind: type[0] === 'integer' ? 'int' : 'number',
				min: schema.minimum,
				max: schema.maximum
			};
		case 'string': {
			if (schema.format === 'date' || schema.format === 'date-time' || schema.format === 'time')
				return {
					...common,
					kind: schema.format === 'date' ? 'date' : schema.format === 'time' ? 'time' : 'instant'
				};
			const format = schema.format === 'uri' ? 'url' : schema.format;
			return {
				...common,
				kind: 'text',
				max: schema.maxLength,
				...(isTextFormat(format) ? { format } : {})
			};
		}
		default:
			return { ...common, kind: 'json' };
	}
}

export function jsonSchemaInitial(schema: JsonSchema, root: JsonSchema = schema): Json {
	const resolved = resolveJsonSchema(schema, root);
	if (typeof resolved === 'boolean') return null;
	if (resolved.default !== undefined) return resolved.default;
	if (resolved.const !== undefined) return resolved.const;
	if (resolved.type === 'object') return {};
	if (resolved.type === 'array') return [];
	return null;
}

/** Declared sections in their authored order; advanced groups follow the main fields. */
export function jsonSchemaGroups(schema: Exclude<JsonSchema, boolean>, root: JsonSchema = schema) {
	const groups = new Map<
		string,
		{
			title: string;
			advanced: boolean;
			fields: { name: string; schema: JsonSchema; required: boolean }[];
		}
	>();
	const fields = Object.entries(schema.properties ?? {}).map(([name, child]) => ({
		name,
		schema: resolveJsonSchema(child, root),
		required: schema.required?.includes(name) ?? false
	}));
	fields.sort(
		(a, b) =>
			(typeof a.schema === 'boolean' ? 0 : (a.schema['x-norbital']?.order ?? 0)) -
			(typeof b.schema === 'boolean' ? 0 : (b.schema['x-norbital']?.order ?? 0))
	);
	for (const field of fields) {
		const meta = typeof field.schema === 'boolean' ? undefined : field.schema['x-norbital'];
		const advanced = meta?.advanced ?? false,
			title = meta?.section ?? '',
			key = `${advanced}:${title}`;
		if (!groups.has(key)) groups.set(key, { title, advanced, fields: [] });
		groups.get(key)!.fields.push(field);
	}
	return [...groups.values()].sort((a, b) => Number(a.advanced) - Number(b.advanced));
}
