import { Array as Arr, Predicate, Schema } from 'effect';
import type { Json, Kind } from './kind.js';

/** JSON Schema is data, never executable code. Remote references are deliberately not fetched. */
export type JsonSchema =
	| boolean
	| {
			readonly [keyword: string]: unknown;
			readonly $ref?: string;
			readonly type?: string | readonly string[];
			readonly title?: string;
			readonly description?: string;
			readonly properties?: Readonly<Record<string, JsonSchema>>;
			readonly required?: readonly string[];
			readonly items?: JsonSchema;
			readonly enum?: readonly Json[];
			readonly const?: Json;
			readonly default?: Json;
			readonly readOnly?: boolean;
			readonly 'x-norbital'?: {
				readonly datatype?: string;
				readonly section?: string;
				readonly advanced?: boolean;
				readonly order?: number;
			};
	  };

const isJson = Schema.is(Schema.Json);
const isStrings = (value: unknown) => Arr.isArray(value) && value.every(Predicate.isString);
const absentOr = (value: unknown, check: (value: unknown) => boolean) =>
	value === undefined || check(value);
const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
	Predicate.isObject(value) && !Arr.isArray(value);

/** Whether a stored value is a JSON Schema in the keywords this renderer reads: decode once where a schema enters a page. */
export function isJsonSchema(value: unknown): value is JsonSchema {
	if (Predicate.isBoolean(value)) return true;
	if (!isRecord(value)) return false;
	const meta = value['x-norbital'];
	return (
		absentOr(value.$ref, Predicate.isString) &&
		absentOr(value.type, (type) => Predicate.isString(type) || isStrings(type)) &&
		absentOr(value.title, Predicate.isString) &&
		absentOr(value.description, Predicate.isString) &&
		absentOr(
			value.properties,
			(properties) => isRecord(properties) && Object.values(properties).every(isJsonSchema)
		) &&
		absentOr(value.required, isStrings) &&
		absentOr(value.items, isJsonSchema) &&
		absentOr(value.enum, (values) => Arr.isArray(values) && values.every(isJson)) &&
		absentOr(value.const, isJson) &&
		absentOr(value.default, isJson) &&
		absentOr(value.readOnly, Predicate.isBoolean) &&
		absentOr(
			meta,
			(held) =>
				isRecord(held) &&
				absentOr(held.datatype, Predicate.isString) &&
				absentOr(held.section, Predicate.isString) &&
				absentOr(held.advanced, Predicate.isBoolean) &&
				absentOr(held.order, Predicate.isNumber)
		)
	);
}

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
const requiresOnly = (part: unknown) =>
	isRecord(part) &&
	Object.entries(part).every(
		([key, arm]) =>
			arm === undefined ||
			key === 'if' ||
			((key === 'then' || key === 'else') &&
				isRecord(arm) &&
				Object.keys(arm).every((keyword) => keyword === 'required'))
	);
/**
 * Whether a schema composes others in a way that changes its shape. Conditionals (top-level or in `allOf`) that only
 * require keys do not: the base object renders and the caller's validator enforces them.
 */
export function composesJsonSchema(schema: Exclude<JsonSchema, boolean>): boolean {
	const { if: when, then, else: otherwise, allOf, ...rest } = schema;
	if (COMPOSITIONS.some((keyword) => keyword in rest)) return true;
	const conditionals = [
		...(when === undefined && then === undefined && otherwise === undefined
			? []
			: [{ if: when, then, else: otherwise }]),
		...(allOf === undefined ? [] : Arr.isArray(allOf) ? allOf : [null])
	];
	return !conditionals.every(requiresOnly);
}

/** Whether a node's `type` admits `null`, so clearing it writes null instead of removing the key. */
export const nullableJsonSchema = (schema: JsonSchema) =>
	typeof schema !== 'boolean' &&
	(schema.type === 'null' || (Arr.isArray(schema.type) && schema.type.includes('null')));

/** Resolve local JSON Pointers, with cycle detection. Unsupported references keep their JSON editor. */
export function resolveJsonSchema(schema: JsonSchema, root: JsonSchema = schema): JsonSchema {
	const seen = new Set<string>();
	while (typeof schema !== 'boolean' && schema.$ref !== undefined) {
		const ref = schema.$ref;
		if (!ref.startsWith('#/') || seen.has(ref)) return true;
		seen.add(ref);
		let target: unknown = root;
		for (const part of ref.slice(2).split('/')) {
			const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
			target =
				typeof target === 'object' && target !== null && Object.hasOwn(target, key)
					? (target as Record<string, unknown>)[key]
					: undefined;
		}
		if (
			typeof target !== 'boolean' &&
			(typeof target !== 'object' || target === null || Arr.isArray(target))
		)
			return true;
		const { $ref: _ref, ...siblings } = schema;
		// Sibling assertions are intersections, not overrides. Keep ambiguous intersections in JSON.
		if (typeof target === 'boolean') return Object.keys(siblings).length === 0 ? target : true;
		const resolved = target as Exclude<JsonSchema, boolean>;
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

/** A conservative rendering plan. Validation remains the caller/server's JSON Schema validator. */
export function jsonSchemaKind(schema: JsonSchema): Kind {
	if (typeof schema === 'boolean') return { kind: 'json' };
	const common = { label: schema.title, help: schema.description };
	if (composesJsonSchema(schema)) return { ...common, kind: 'json' };
	if (schema['x-norbital']?.datatype)
		return { ...common, kind: 'custom', of: schema['x-norbital'].datatype };
	if (schema.enum?.every((v) => typeof v === 'string'))
		return { ...common, kind: 'enum', values: schema.enum as readonly string[] };
	const type = Arr.isArray(schema.type) ? schema.type.filter((t) => t !== 'null') : [schema.type];
	if (type.length !== 1) return { ...common, kind: 'json' };
	const number = (key: string) =>
		typeof schema[key] === 'number' ? (schema[key] as number) : undefined;
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
						min: number('minItems'),
						max: number('maxItems')
					};
		case 'boolean':
			return { ...common, kind: 'bool' };
		case 'integer':
		case 'number':
			return {
				...common,
				kind: type[0] === 'integer' ? 'int' : 'number',
				min: number('minimum'),
				max: number('maximum')
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
				max: number('maxLength'),
				...(['email', 'url', 'phone', 'zone', 'markdown'].includes(String(format))
					? { format: format as 'email' | 'url' | 'phone' | 'zone' | 'markdown' }
					: {})
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

/**
 * Fields in declaration order (numeric `x-norbital.order` first sorts them). Fields without an `x-norbital.section`
 * form one untitled group; named sections follow it, `advanced` ones last and disclosed on demand.
 */
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
		const advanced = meta?.advanced ?? false;
		const title = meta?.section ?? '';
		const key = `${advanced}:${title}`;
		if (!groups.has(key)) groups.set(key, { title, advanced, fields: [] });
		groups.get(key)!.fields.push(field);
	}
	return [...groups.values()].sort((a, b) => Number(a.advanced) - Number(b.advanced));
}
