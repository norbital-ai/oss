import type { Json, Kind } from './kind.js';

/** JSON Schema is data, never executable code. Remote references are deliberately not fetched. */
export type JsonSchema = boolean | {
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
	readonly 'x-norbital'?: { readonly datatype?: string; readonly section?: string; readonly advanced?: boolean; readonly order?: number };
};

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
			target = typeof target === 'object' && target !== null && Object.hasOwn(target, key)
				? (target as Record<string, unknown>)[key] : undefined;
		}
		if (typeof target !== 'boolean' && (typeof target !== 'object' || target === null || Array.isArray(target))) return true;
		const { $ref: _ref, ...siblings } = schema;
		// Sibling assertions are intersections, not overrides. Keep ambiguous intersections in JSON.
		if (typeof target === 'boolean') return Object.keys(siblings).length === 0 ? target : true;
		const resolved = target as Exclude<JsonSchema, boolean>;
		if (Object.keys(siblings).some((key) => key in resolved && !['title', 'description', 'x-norbital'].includes(key))) return true;
		schema = { ...resolved, ...siblings };
	}
	return schema;
}

/** A conservative rendering plan. Validation remains the caller/server's JSON Schema validator. */
export function jsonSchemaKind(schema: JsonSchema): Kind {
	if (typeof schema === 'boolean') return { kind: 'json' };
	const common = { label: schema.title, help: schema.description };
	if (['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', 'not', 'dependentSchemas', 'patternProperties', 'prefixItems'].some((k) => k in schema)) return { ...common, kind: 'json' };
	if (schema['x-norbital']?.datatype) return { ...common, kind: 'custom', of: schema['x-norbital'].datatype };
	if (schema.enum?.every((v) => typeof v === 'string')) return { ...common, kind: 'enum', values: schema.enum as readonly string[] };
	const type = Array.isArray(schema.type) ? schema.type.filter((t) => t !== 'null') : [schema.type];
	if (type.length !== 1) return { ...common, kind: 'json' };
	const number = (key: string) => typeof schema[key] === 'number' ? schema[key] as number : undefined;
	switch (type[0]) {
		case 'object': return { ...common, kind: 'object', fields: {} };
		case 'array': return schema.items === undefined ? { ...common, kind: 'json' } : { ...common, kind: 'list', of: { kind: 'json' }, min: number('minItems'), max: number('maxItems') };
		case 'boolean': return { ...common, kind: 'bool' };
		case 'integer': case 'number': return { ...common, kind: type[0] === 'integer' ? 'int' : 'number', min: number('minimum'), max: number('maximum') };
		case 'string': {
			if (schema.format === 'date' || schema.format === 'date-time' || schema.format === 'time') return { ...common, kind: schema.format === 'date' ? 'date' : schema.format === 'time' ? 'time' : 'instant' };
			const format = schema.format === 'uri' ? 'url' : schema.format;
			return { ...common, kind: 'text', max: number('maxLength'), ...(['email', 'url', 'phone', 'zone', 'markdown'].includes(String(format)) ? { format: format as 'email' | 'url' | 'phone' | 'zone' | 'markdown' } : {}) };
		}
		default: return { ...common, kind: 'json' };
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

/** Required fields first, secondary fields disclosed together; explicit sections/order override heuristics. */
export function jsonSchemaGroups(schema: Exclude<JsonSchema, boolean>, root: JsonSchema = schema) {
	const groups = new Map<string, { title: string; advanced: boolean; fields: { name: string; schema: JsonSchema; required: boolean }[] }>();
	const fields = Object.entries(schema.properties ?? {}).map(([name, child]) => ({ name, schema: resolveJsonSchema(child, root), required: schema.required?.includes(name) ?? false }));
	fields.sort((a, b) => (typeof a.schema === 'boolean' ? 0 : a.schema['x-norbital']?.order ?? 0) - (typeof b.schema === 'boolean' ? 0 : b.schema['x-norbital']?.order ?? 0));
	for (const field of fields) {
		const meta = typeof field.schema === 'boolean' ? undefined : field.schema['x-norbital'];
		const advanced = meta?.advanced ?? !field.required;
		const title = meta?.section ?? (advanced ? 'Additional details' : 'Required details');
		const key = `${advanced}:${title}`;
		if (!groups.has(key)) groups.set(key, { title, advanced, fields: [] });
		groups.get(key)!.fields.push(field);
	}
	return [...groups.values()].sort((a, b) => Number(a.advanced) - Number(b.advanced));
}
