import { BigDecimal, Predicate, Result, Schema } from 'effect';
import { canonical, field_info, FieldSpec, HistoryTableMetadata, SYSTEM_COLUMN_SET, type Json } from '@norbital-ai/store';

import { input_schema } from '@norbital-ai/store/kind';
import { decodeInput } from '../callables/decode.ts';
import type { EngineManifest } from '../manifest.ts';
import { storedWireValue } from '../db/stored.ts';
import { BoltError } from '../../protocol/errors.ts';

export const HistorySchema = Schema.Struct({
	id: Schema.String,
	lineage: Schema.String,
	model: Schema.String,
	definition: HistoryTableMetadata,
	fields: Schema.Record(Schema.String, Schema.String),
	current: Schema.optionalKey(Schema.Boolean)
});
export type HistorySchema = typeof HistorySchema.Type;
export type HistoricalValue = {
	readonly version: HistorySchema;
	readonly field: string;
	readonly value: Json;
};

const json_object = (value: Json | undefined): value is Readonly<Record<string, Json>> =>
	value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
const json_list = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);
const decode_kind = Schema.decodeUnknownResult(FieldSpec, { onExcessProperty: 'error' });
/** Project only validated current reference metadata for display; unsupported archived descriptors stay raw. */
function historical_descriptor(value: Json): Json {
	if (!json_object(value)) return value;
	const descriptor: Record<string, Json> = { ...value };
	if (value['kind'] === 'ref' && Result.isSuccess(decode_kind(value)))
		for (const key of ['on_delete', 'owned', 'inverse', 'where']) delete descriptor[key];
	const fields = (members: Json): Json => !json_object(members) ? members
		: Object.fromEntries(Object.entries(members).map(([name, kind]) => [name, historical_descriptor(kind)]));
	if (value['kind'] === 'object') {
		if (value['fields'] !== undefined) descriptor['fields'] = fields(value['fields']);
		if (value['rest'] !== undefined) descriptor['rest'] = historical_descriptor(value['rest']);
	} else if (value['kind'] === 'union') {
		if (json_object(value['arms'])) descriptor['arms'] = Object.fromEntries(Object.entries(value['arms']).map(([tag, members]) => [tag, fields(members)]));
		if (json_list(value['of'])) descriptor['of'] = value['of'].map(historical_descriptor);
	} else if (value['kind'] === 'record' && value['of'] !== undefined)
		descriptor['of'] = historical_descriptor(value['of']);
	else if (value['kind'] === 'json' && value['shape'] !== undefined)
		descriptor['shape'] = historical_descriptor(value['shape']);
	return descriptor;
}
const ComputedHistoryKind = Schema.Struct({
	kind: Schema.Literals(['text', 'int', 'decimal', 'money', 'bool', 'date', 'instant']),
	scale: Schema.optionalKey(Schema.Number)
});
/** Computed values are displayed as written, without executing an archived expression or tenant renderer. */
export function historyKinds(version: HistorySchema): Readonly<Record<string, FieldSpec>> {
	const kinds: Record<string, FieldSpec> = {};
	for (const [name, archived] of Object.entries(version.definition.fields)) {
		const kind = decode_kind(historical_descriptor(archived));
		if (Result.isSuccess(kind)) kinds[name] = kind.success;
	}
	for (const [name, archived] of Object.entries(version.definition.computed ?? {})) {
		const spec = Schema.decodeUnknownResult(ComputedHistoryKind)(archived);
		if (Result.isSuccess(spec)) kinds[name] = spec.success.kind === 'decimal'
			? { kind: 'decimal', scale: spec.success.scale ?? 2 } : { kind: spec.success.kind };
	}
	return kinds;
}

export function historicalValue(kind: FieldSpec | undefined, value: Json): Json {
	return kind === undefined ? value : storedWireValue(field_info('', kind), value) ?? value;
}

/** Decode physical reference arms once, and fold changes by stable identity instead of mutable field names. */
export function historyChanges(
	version: HistorySchema,
	changes: Readonly<Record<string, Json>>
): ReadonlyMap<string, HistoricalValue> | BoltError {
	const changed = new Map<string, Json>();
	const kinds = historyKinds(version);
	const consumed = new Set<string>();
	for (const [name, kind] of Object.entries(kinds)) {
		const targets =
			kind.kind === 'ref' && typeof kind.to !== 'string' && kind.to.length > 1
				? kind.to
				: undefined;
		let value = changes[name];
		if (targets !== undefined) {
			const present = targets.filter((target) => Object.hasOwn(changes, `${name}__${target}`));
			if (present.length === 0) continue;
			for (const target of present) consumed.add(`${name}__${target}`);
			const target = present.find((target) => changes[`${name}__${target}`] !== null);
			value =
				target === undefined ? null : { model: target, id: changes[`${name}__${target}`] ?? null };
		}
		if (
			kind.kind === 'ref' &&
			typeof kind.to !== 'string' &&
			kind.to.length === 1 &&
			typeof value === 'string'
		) {
			const [target] = kind.to;
			if (target === undefined)
				return BoltError.make('schema', 'decode', `History schema ${version.id} has an invalid reference descriptor.`);
			value = { model: target, id: value };
		}
		if (value === undefined) continue;
		consumed.add(name);
		changed.set(name, historicalValue(kind, value));
	}
	for (const [name, value] of Object.entries(changes))
		if (!consumed.has(name)) changed.set(name, value);
	const values = new Map<string, HistoricalValue>();
	for (const [field, value] of changed) {
		const identity = SYSTEM_COLUMN_SET.has(field) ? `system:${field}` : version.fields[field];
		if (identity === undefined)
			return BoltError.make('schema', 'decode', `History schema ${version.id} has no identity for ${field}.`);
		values.set(identity, { version, field, value });
	}
	return values;
}

const numeric = new Set(['int', 'number', 'decimal', 'money', 'sum', 'count']);
/** Only deterministic value-preserving conversions; current validation still decides whether a value is admissible. */
export function compatibleHistoryValue(
	value: Json,
	before: FieldSpec,
	after: FieldSpec,
	custom_fields?: EngineManifest['custom_fields']
): Json | undefined {
	if (before.kind === 'custom' && (after.kind !== 'custom' || before.of !== after.of))
		return undefined;
	// A stored file reference may carry the upload's size and hash metadata.
	if (after.kind === 'file')
		return Result.isSuccess(Schema.decodeUnknownResult(input_schema(after))(value))
			? value
			: undefined;
	if (
		before.kind === 'money' &&
		after.kind === 'money' &&
		canonical(before.currency) !== canonical(after.currency)
	)
		return undefined;
	let converted = value;
	if (value !== null && before.kind === 'ref') {
		if (after.kind !== 'ref') return undefined;
		const target =
			typeof before.to === 'string'
				? before.to
				: Predicate.isObject(value)
					? value['model']
					: undefined;
		const id =
			typeof value === 'string' ? value : Predicate.isObject(value) ? value['id'] : undefined;
		const targets = typeof after.to === 'string' ? [after.to] : after.to;
		if (typeof target !== 'string' || typeof id !== 'string' || !targets.includes(target))
			return undefined;
		converted = typeof after.to === 'string' ? id : { model: target, id };
	} else if (after.kind === 'ref' && before.kind !== 'ref' && value !== null) return undefined;
	else if (value !== null && numeric.has(after.kind)) {
		const scalar = value;
		if (['decimal', 'money', 'sum'].includes(after.kind)) {
			if (
				(typeof scalar !== 'string' && typeof scalar !== 'number') ||
				!/^-?\d+(\.\d+)?$/.test(String(scalar))
			)
				return undefined;
			const sameKind = canonical(before) === canonical(after);
			const scale =
				after.kind === 'decimal'
					? after.scale
					: after.kind === 'money'
						? (after.scale ??
							(after.currency !== undefined && /^[A-Z]{3}$/.test(after.currency)
								? new Intl.NumberFormat('en', { style: 'currency', currency: after.currency }).resolvedOptions()
										.maximumFractionDigits
								: undefined))
						: undefined;
			if (
				!sameKind &&
				scale !== undefined &&
				(String(scalar).split('.')[1]?.replace(/0+$/, '').length ?? 0) > scale
			)
				return undefined;
			if (!sameKind && after.kind === 'decimal' && after.precision !== undefined) {
				const exponent = after.precision - after.scale;
				const limit =
					exponent >= 0 ? `1${'0'.repeat(exponent)}` : `0.${'0'.repeat(-exponent - 1)}1`;
				if (
					BigDecimal.isGreaterThanOrEqualTo(
						BigDecimal.abs(BigDecimal.fromStringUnsafe(String(scalar))),
						BigDecimal.fromStringUnsafe(limit)
					)
				)
					return undefined;
			}
			converted = String(scalar);
		} else if (after.kind === 'number' && typeof scalar === 'number') converted = scalar;
		else {
			if (
				(typeof scalar !== 'string' && typeof scalar !== 'number') ||
				!/^-?\d+(\.\d+)?$/.test(String(scalar))
			)
				return undefined;
			const n = Number(scalar);
			if (!Number.isFinite(n) || (after.kind !== 'number' && !Number.isSafeInteger(n)))
				return undefined;
			if (Number.isInteger(n) && !Number.isSafeInteger(n)) return undefined;
			if (
				((after.kind === 'int' && after.storage !== 'int64') || after.kind === 'count') &&
				(n < -2147483648 || n > 2147483647)
			)
				return undefined;
			if (after.kind !== 'number' && !/^-?\d+(\.0+)?$/.test(String(scalar))) return undefined;
			converted = n;
		}
	} else if (
		after.kind === 'text' &&
		after.many !== true &&
		numeric.has(before.kind)
	) {
		converted = value === null ? null : String(value);
	}
	const decoded = decodeInput({ value: after }, { value: converted }, custom_fields);
	if (decoded.problems.length > 0 || decoded.value === undefined) return undefined;
	const encoded = decoded.value;
	return Predicate.isObject(encoded) ? encoded['value'] : undefined;
}

