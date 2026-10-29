import { Decimal } from '@norbital-ai/std/decimal';
import { Array as Arr, Schema } from 'effect';
import { valueObject, type Kind, type Value } from './kind.js';
import { resolveJsonSchema, type JsonSchema } from './json-schema.js';

/** Stable row identities by JSON Pointer; a tuple names a composite identity. */
export type ArrayKeys = Readonly<Record<string, string | readonly string[]>>;
/** One matched list row, retaining each version's original index and missing side. */
export type DataPair = {
	before: Value | undefined;
	value: Value | undefined;
	beforeIndex: number | undefined;
	index: number | undefined;
};

/** Structures only: decimals remain opaque leaves. */
export function dataEntries(value: Value | undefined): Readonly<Record<string, Value>> | undefined {
	return valueObject(value) ? value : undefined;
}

/** Equality preserves missing/null and scalar types; object declaration order is immaterial. */
export function dataEqual(before: Value | undefined, value: Value | undefined): boolean {
	if (before === value) return true;
	if (before === undefined || value === undefined) return false;
	if (before instanceof Decimal || value instanceof Decimal)
		return before instanceof Decimal && value instanceof Decimal && before.eq(value);
	if (Arr.isArray<Value>(before) || Arr.isArray<Value>(value))
		return (
			Arr.isArray<Value>(before) &&
			Arr.isArray<Value>(value) &&
			before.length === value.length &&
			before.every((item, index) => dataEqual(item, value[index]))
		);
	const old = dataEntries(before),
		next = dataEntries(value);
	if (old === undefined || next === undefined) return false;
	const keys = Object.keys(old);
	return (
		keys.length === Object.keys(next).length &&
		keys.every((key) => Object.hasOwn(next, key) && dataEqual(old[key], next[key]))
	);
}

type ObservedType = 'null' | 'boolean' | 'integer' | 'number' | 'string' | 'array' | 'object';
const observedType = (value: Value): ObservedType => {
	if (value === null) return 'null';
	if (value instanceof Decimal) return 'number';
	if (Arr.isArray<Value>(value)) return 'array';
	switch (typeof value) {
		case 'boolean':
			return 'boolean';
		case 'number':
			return Number.isInteger(value) ? 'integer' : 'number';
		case 'string':
			return 'string';
		default:
			return 'object';
	}
};

function inferValues(values: readonly Value[]): JsonSchema {
	if (values.length === 0) return {};
	const groups = new Map<ObservedType, Value[]>();
	for (const value of values) {
		const type = observedType(value);
		const group = groups.get(type);
		if (group === undefined) groups.set(type, [value]);
		else group.push(value);
	}
	if (groups.has('number') && groups.has('integer')) {
		groups.set('number', [...(groups.get('number') ?? []), ...(groups.get('integer') ?? [])]);
		groups.delete('integer');
	}
	const schemas: JsonSchema[] = [];
	const scalarTypes: string[] = [];
	for (const [type, held] of groups) {
		if (type === 'object') {
			const objects = held.map(dataEntries).filter((object) => object !== undefined);
			const keys = [...new Set(objects.flatMap((object) => Object.keys(object)))];
			schemas.push({
				type: 'object',
				properties: Object.fromEntries(
					keys.map((key) => [
						key,
						inferValues(
							objects.flatMap((object) => (Object.hasOwn(object, key) ? [object[key]] : []))
						)
					])
				)
			});
		} else if (type === 'array') {
			schemas.push({
				type: 'array',
				items: inferValues(held.flatMap((value) => (Arr.isArray<Value>(value) ? value : [])))
			});
		} else scalarTypes.push(type);
	}
	if (scalarTypes.length > 0)
		schemas.push({ type: scalarTypes.length === 1 ? scalarTypes[0] : scalarTypes });
	return schemas.length === 1 ? schemas[0] : { anyOf: schemas };
}

/** Only observed shapes: every list item contributes, with no invented formats, defaults or required keys. */
export function inferJsonSchema(value: Value | undefined): JsonSchema {
	return value === undefined ? {} : inferValues([value]);
}

type SchemaObject = Exclude<JsonSchema, boolean>;
const schemaTypes = (schema: SchemaObject): readonly string[] =>
	typeof schema.type === 'string' ? [schema.type] : (schema.type ?? []);
const intersection = (left: JsonSchema, right: JsonSchema): JsonSchema =>
	left === true
		? right
		: right === true
			? left
			: left === false || right === false
				? false
				: { allOf: [left, right] };

const isLower = Schema.is(
	Schema.Literals(['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'])
);
const isUpper = Schema.is(
	Schema.Literals(['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'])
);
/** Merge only intersections whose shared keywords have an unambiguous rendering plan. */
function intersectPlan(left: JsonSchema, right: JsonSchema): JsonSchema | undefined {
	if (left === false || right === false) return false;
	if (left === true) return right;
	if (right === true) return left;
	const merged: { -readonly [K in keyof SchemaObject]: SchemaObject[K] } = { ...right, ...left };
	for (const key of Object.keys(left).filter((key) => Object.hasOwn(right, key))) {
		if (left[key] === right[key] || key === 'title' || key === 'description') continue;
		if (key === 'type') {
			const types = [
				...new Set(
					schemaTypes(left).flatMap((a) =>
						schemaTypes(right).flatMap((b) =>
							a === b
								? [a]
								: (a === 'number' && b === 'integer') || (a === 'integer' && b === 'number')
									? ['integer']
									: []
						)
					)
				)
			];
			if (types.length === 0) return false;
			merged.type = types.length === 1 ? types[0] : types;
		} else if (key === 'properties') {
			const a = left.properties ?? {},
				b = right.properties ?? {};
			merged.properties = Object.fromEntries(
				[...new Set([...Object.keys(a), ...Object.keys(b)])].map((field) => [
					field,
					Object.hasOwn(a, field) && Object.hasOwn(b, field)
						? intersection(a[field], b[field])
						: Object.hasOwn(a, field)
							? a[field]
							: b[field]
				])
			);
		} else if (key === 'required')
			merged.required = [...new Set([...(left.required ?? []), ...(right.required ?? [])])];
		else if (key === 'items' && left.items !== undefined && right.items !== undefined)
			merged.items = intersection(left.items, right.items);
		else if (
			key === 'additionalProperties' &&
			left.additionalProperties !== undefined &&
			right.additionalProperties !== undefined
		)
			merged.additionalProperties = intersection(
				left.additionalProperties,
				right.additionalProperties
			);
		else if (isLower(key) && left[key] !== undefined && right[key] !== undefined)
			merged[key] = Math.max(left[key], right[key]);
		else if (isUpper(key) && left[key] !== undefined && right[key] !== undefined)
			merged[key] = Math.min(left[key], right[key]);
		else if (key === 'enum' && left.enum !== undefined && right.enum !== undefined)
			merged.enum = left.enum.filter((item) => right.enum?.some((other) => dataEqual(item, other)));
		else if (key === 'const' && left.const !== undefined && right.const !== undefined) {
			if (!dataEqual(left.const, right.const)) return false;
		} else return undefined;
	}
	return merged;
}

/**
 * A display-only schema plan. Original schemas remain the validator/authoring contract; this folds local structural
 * intersections and chooses a variant only when observed type/const/enum discriminants select exactly one arm.
 */
export function structuredSchema(schema: JsonSchema, root: JsonSchema, value?: Value): JsonSchema {
	function compatible(raw: JsonSchema, held: Value, depth: number): boolean | undefined {
		if (depth >= 24) return undefined;
		const current = resolveJsonSchema(raw, root);
		if (typeof current === 'boolean') return current === false ? false : undefined;
		let evidence = false;
		if (current.const !== undefined || Object.hasOwn(current, 'const')) {
			if (!dataEqual(current.const, held)) return false;
			evidence = true;
		}
		if (current.enum !== undefined) {
			if (!current.enum.some((item) => dataEqual(item, held))) return false;
			evidence = true;
		}
		if (current.type !== undefined) {
			const type = observedType(held);
			if (
				!schemaTypes(current).some(
					(allowed) => allowed === type || (allowed === 'number' && type === 'integer')
				)
			)
				return false;
			evidence = true;
		}
		const entries = dataEntries(held);
		if (entries !== undefined) {
			if (current.required?.some((key) => !Object.hasOwn(entries, key))) return false;
			for (const [key, child] of Object.entries(current.properties ?? {})) {
				if (!Object.hasOwn(entries, key)) continue;
				const match = compatible(child, entries[key], depth + 1);
				if (match === false) return false;
				if (match === true) evidence = true;
			}
		}
		return evidence ? true : undefined;
	}
	function plan(
		raw: JsonSchema,
		held: Value | undefined,
		depth: number,
		seen: ReadonlySet<JsonSchema>
	): JsonSchema {
		if (typeof raw === 'boolean' || depth >= 24 || seen.has(raw)) return raw;
		const nextSeen = new Set(seen).add(raw);
		const resolved = resolveJsonSchema(raw, root);
		if (typeof resolved === 'boolean')
			return resolved === false || raw.$ref === undefined ? resolved : raw;
		let current: JsonSchema = resolved;
		if (resolved.allOf !== undefined) {
			const { allOf: parts, ...base } = resolved;
			current = base;
			for (const part of parts) {
				const merged = intersectPlan(current, plan(part, held, depth + 1, nextSeen));
				if (merged === undefined) return resolved;
				current = merged;
			}
		}
		if (typeof current === 'boolean' || held === undefined) return current;
		const variants = current.oneOf ?? current.anyOf;
		if (variants === undefined) return current;
		const candidates = variants.map((branch) => plan(branch, held, depth + 1, nextSeen));
		const matches = candidates.filter((branch) => compatible(branch, held, depth + 1) === true);
		// Unknown arms can still match; selecting a known arm beside one would hide a possible shape.
		if (
			matches.length !== 1 ||
			candidates.some((branch) => compatible(branch, held, depth + 1) === undefined)
		)
			return current;
		const { oneOf: _oneOf, anyOf: _anyOf, ...base } = current;
		return intersectPlan(base, matches[0]) ?? current;
	}
	return plan(schema, value, 0, new Set());
}

/**
 * The value a new form starts from: the schema's defaults filled into the absent (or null) places of `value`.
 * Returns `undefined` when every present value already satisfies the schema, so an editor only writes a real change.
 */
export function dataDefaults(
	schema: JsonSchema,
	value: Value | undefined,
	root: JsonSchema = schema
): Value | undefined {
	let changed = false;
	const fill = (input: JsonSchema, held: Value | undefined): Value | undefined => {
		const resolved = structuredSchema(input, root, held);
		if (typeof resolved === 'boolean') return held;
		if (held === undefined || held === null) {
			if (resolved.default !== undefined) {
				changed = true;
				return resolved.default;
			}
			if (resolved.properties !== undefined) {
				const next = Object.fromEntries(
					Object.entries(resolved.properties).flatMap(([key, child]) => {
						const filled = fill(child, undefined);
						return filled === undefined ? [] : [[key, filled]];
					})
				);
				if (Object.keys(next).length > 0) {
					changed = true;
					return next;
				}
			}
			return held;
		}
		if (Arr.isArray<Value>(held)) {
			if (resolved.items === undefined) return held;
			let changedItems = false;
			const next = held.map((item) => {
				const filled = fill(resolved.items!, item);
				if (filled === undefined) return item;
				changedItems = true;
				return filled;
			});
			if (changedItems) changed = true;
			return changedItems ? next : held;
		}
		const entries = dataEntries(held);
		if (entries === undefined || resolved.properties === undefined) return held;
		let changedFields = false;
		const next = { ...entries };
		for (const [key, child] of Object.entries(resolved.properties)) {
			const current = entries[key];
			const filled = fill(child, current);
			if (filled !== undefined && filled !== current) {
				next[key] = filled;
				changedFields = true;
			}
		}
		if (changedFields) changed = true;
		return changedFields ? next : held;
	};
	const next = fill(schema, value);
	return changed ? next : undefined;
}

/** The schema's structural description; callers retain the original Kind for native leaf rendering. */
export function kindJsonSchema(kind: Kind): JsonSchema {
	const common = { title: kind.label, description: kind.help };
	const object = (fields: Readonly<Record<string, Kind>>, rest?: Kind): JsonSchema => {
		const shown = Object.entries(fields).filter(([, child]) => !child.hidden);
		return {
			...common,
			type: 'object',
			properties: Object.fromEntries(shown.map(([key, child]) => [key, kindJsonSchema(child)])),
			required: shown.filter(([, child]) => !child.optional).map(([key]) => key),
			...(rest === undefined ? {} : { additionalProperties: kindJsonSchema(rest) })
		};
	};
	switch (kind.kind) {
		case 'object':
			return object(kind.fields, kind.rest);
		case 'record':
			return { ...common, type: 'object', additionalProperties: kindJsonSchema(kind.of) };
		case 'list':
			return {
				...common,
				type: 'array',
				items: kindJsonSchema(kind.of),
				minItems: kind.min,
				maxItems: kind.max
			};
		case 'json': {
			const shape = kind.shape === undefined ? undefined : kindJsonSchema(kind.shape);
			return shape === undefined || typeof shape === 'boolean' ? common : { ...shape, ...common };
		}
		case 'union':
			return 'of' in kind
				? { ...common, anyOf: kind.of.map(kindJsonSchema) }
				: {
						...common,
						anyOf: Object.entries(kind.arms).map(([tag, fields]) => {
							const arm = object(fields);
							return typeof arm === 'boolean'
								? arm
								: {
										...arm,
										properties: { ...arm.properties, [kind.by]: { type: 'string', const: tag } },
										required: [...new Set([kind.by, ...(arm.required ?? [])])]
									};
						})
					};
		case 'text': {
			const schema: JsonSchema = {
				...common,
				type: 'string',
				format: kind.format,
				maxLength: kind.max
			};
			return kind.many ? { ...common, type: 'array', items: schema } : schema;
		}
		case 'enum': {
			const schema: JsonSchema = { ...common, type: 'string', enum: kind.values };
			return kind.many ? { ...common, type: 'array', items: schema } : schema;
		}
		case 'state':
			return { ...common, type: 'string', enum: Object.keys(kind.states) };
		case 'int':
		case 'number':
		case 'decimal':
			return {
				...common,
				type: kind.kind === 'int' ? 'integer' : 'number',
				minimum: kind.min,
				maximum: kind.max
			};
		case 'count':
			return { ...common, type: 'integer' };
		case 'duration':
		case 'money':
		case 'sum':
			return { ...common, type: 'number' };
		case 'bool':
			return { ...common, type: 'boolean' };
		case 'date':
			return { ...common, type: 'string', format: 'date' };
		case 'instant':
			return { ...common, type: 'string', format: 'date-time' };
		case 'time':
			return { ...common, type: 'string', format: 'time' };
		case 'period': {
			const date = kind.of === 'date';
			const format = date ? 'date' : 'date-time';
			return {
				...common,
				type: 'object',
				properties: {
					[date ? 'from' : 'start']: { type: 'string', format },
					[date ? 'to' : 'end']: { type: ['string', 'null'], format }
				}
			};
		}
		case 'point':
			return {
				...common,
				type: 'object',
				properties: { lat: { type: 'number' }, lng: { type: 'number' } }
			};
		case 'file':
			return kind.multiple
				? { ...common, type: 'array', items: { type: 'object' } }
				: { ...common, type: 'object' };
		case 'custom': {
			const schema: JsonSchema = { ...common, 'x-norbital': { datatype: kind.of } };
			return kind.many ? { ...common, type: 'array', items: schema } : schema;
		}
		case 'vector':
			return {
				...common,
				type: 'array',
				items: { type: 'number' },
				minItems: kind.dim,
				maxItems: kind.dim
			};
		case 'ref':
			return typeof kind.to === 'string'
				? { ...common, type: 'string' }
				: { ...common, type: 'object' };
		case 'currency':
		case 'seq':
		case 'id':
			return { ...common, type: 'string' };
	}
}

const identityPart = (value: Value | undefined): string | undefined => {
	if (value instanceof Decimal)
		return `decimal:${value
			.toString()
			.replace(/(\.\d*?)0+$/, '$1')
			.replace(/\.$/, '')}`;
	return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
		? `${typeof value}:${String(value)}`
		: undefined;
};
const identities = (rows: readonly Value[], fields: readonly string[]): string[] | undefined => {
	const keys: string[] = [];
	for (const row of rows) {
		const entries = dataEntries(row);
		if (entries === undefined) return undefined;
		const parts = fields.map((field) =>
			identityPart(Object.hasOwn(entries, field) ? entries[field] : undefined)
		);
		if (parts.some((part) => part === undefined)) return undefined;
		keys.push(JSON.stringify(parts));
	}
	return new Set(keys).size === keys.length ? keys : undefined;
};

/** Match unique explicit identities; ambiguous/missing identities retain positional list semantics. */
export function pairDataRows(
	before: readonly Value[],
	value: readonly Value[],
	key?: string | readonly string[]
): DataPair[] {
	const fields = typeof key === 'string' ? [key] : key;
	const oldKeys = fields?.length ? identities(before, fields) : undefined;
	const nextKeys = fields?.length ? identities(value, fields) : undefined;
	if (oldKeys === undefined || nextKeys === undefined)
		return Array.from({ length: Math.max(before.length, value.length) }, (_, index) => ({
			before: before[index],
			value: value[index],
			beforeIndex: index < before.length ? index : undefined,
			index: index < value.length ? index : undefined
		}));
	const positions = new Map(oldKeys.map((held, index) => [held, index]));
	const kept = new Set(nextKeys);
	return [
		...value.map((held, index) => {
			const beforeIndex = positions.get(nextKeys[index]);
			return {
				before: beforeIndex === undefined ? undefined : before[beforeIndex],
				value: held,
				beforeIndex,
				index
			};
		}),
		...before.flatMap((held, beforeIndex) =>
			kept.has(oldKeys[beforeIndex])
				? []
				: [
						{
							before: held,
							value: undefined,
							beforeIndex,
							index: undefined
						}
					]
		)
	];
}

const pointerTo = (pointer: string, key: string | number) =>
	`${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** Keyed record-list reordering is not a value change; all other list order remains meaningful. */
export function dataChanged(
	before: Value | undefined,
	value: Value | undefined,
	arrayKeys: ArrayKeys = {},
	pointer = ''
): boolean {
	if (dataEqual(before, value)) return false;
	if (before === undefined || value === undefined) return true;
	if (Arr.isArray<Value>(before) && Arr.isArray<Value>(value))
		return pairDataRows(before, value, arrayKeys[pointer]).some((pair) =>
			dataChanged(
				pair.before,
				pair.value,
				arrayKeys,
				pointerTo(pointer, pair.index ?? pair.beforeIndex ?? 0)
			)
		);
	const old = dataEntries(before),
		next = dataEntries(value);
	return (
		old === undefined ||
		next === undefined ||
		[...new Set([...Object.keys(old), ...Object.keys(next)])].some((key) =>
			dataChanged(
				Object.hasOwn(old, key) ? old[key] : undefined,
				Object.hasOwn(next, key) ? next[key] : undefined,
				arrayKeys,
				pointerTo(pointer, key)
			)
		)
	);
}
