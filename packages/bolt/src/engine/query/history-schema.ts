import { Predicate, Result, Schema } from 'effect';
import { canonical, FieldSpec, TableSpec, SYSTEM_COLUMNS, type Json } from '@norbital-ai/store';
import { Decimal, minorDigits } from '@norbital-ai/std/decimal';
import { encodeWire } from '@norbital-ai/std/wire';
import { inputSchema } from '@norbital-ai/std/kind';
import { decodeInput } from '../callables/decode.ts';
import type { EngineManifest } from '../manifest.ts';

export const HistorySchema = Schema.Struct({
	id: Schema.String,
	lineage: Schema.String,
	model: Schema.String,
	definition: TableSpec,
	fields: Schema.Record(Schema.String, Schema.String),
	current: Schema.optionalKey(Schema.Boolean)
});
export type HistorySchema = typeof HistorySchema.Type;
export const SYSTEM_HISTORY_FIELDS = new Set<string>(SYSTEM_COLUMNS);
export type HistoricalValue = {
	readonly version: HistorySchema | undefined;
	readonly field: string;
	readonly value: Json;
};

/** Computed values are displayed as they were written, without executing today's expression or tenant renderer. */
export function historyKinds(version: HistorySchema): Readonly<Record<string, FieldSpec>> {
	return {
		...version.definition.fields,
		...Object.fromEntries(
			Object.entries(version.definition.computed ?? {}).map(([name, spec]) => [
				name,
				spec.kind === 'decimal' ? { kind: spec.kind, scale: spec.scale ?? 2 } : { kind: spec.kind }
			])
		)
	};
}

export function historicalValue(kind: FieldSpec | undefined, value: Json): Json {
	if (value === null || kind === undefined) return value;
	if (
		['decimal', 'money', 'sum'].includes(kind.kind) &&
		(typeof value === 'number' || typeof value === 'string')
	)
		return { $dec: String(value) };
	if (kind.kind === 'instant' && typeof value === 'string') {
		const date = new Date(value);
		return Number.isNaN(date.valueOf()) ? value : date.toISOString();
	}
	if (kind.kind === 'point' && typeof value === 'string') {
		const point = /^\(([-+.\deE]+),([-+.\deE]+)\)$/.exec(value);
		if (point !== null) return { lng: Number(point[1]), lat: Number(point[2]) };
	}
	if (kind.kind === 'vector' && typeof value === 'string') {
		const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))(value);
		if (Result.isSuccess(decoded)) return decoded.success;
	}
	return value;
}

/** Decode physical reference arms once, and fold changes by stable identity instead of mutable field names. */
export function historyChanges(
	version: HistorySchema | undefined,
	changes: Readonly<Record<string, Json>>
): ReadonlyMap<string, HistoricalValue> {
	const values = new Map<string, HistoricalValue>();
	const kinds = version === undefined ? {} : historyKinds(version);
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
		)
			value = { model: kind.to[0] ?? '', id: value };
		if (value === undefined) continue;
		consumed.add(name);
		values.set(version?.fields[name] ?? `legacy:${name}`, {
			version,
			field: name,
			value: historicalValue(kind, value)
		});
	}
	for (const [name, value] of Object.entries(changes))
		if (!consumed.has(name)) values.set(`legacy:${name}`, { version, field: name, value });
	return values;
}

const numeric = new Set(['int', 'number', 'decimal', 'money', 'sum', 'count', 'duration']);
/** Only deterministic value-preserving conversions; current validation still decides whether a value is admissible. */
export function compatibleHistoryValue(
	value: Json,
	before: FieldSpec | undefined,
	after: FieldSpec,
	customFields?: EngineManifest['customFields']
): Json | undefined {
	if (before?.kind === 'custom' && (after.kind !== 'custom' || before.of !== after.of))
		return undefined;
	// A stored file reference may carry the upload's size and hash metadata.
	if (after.kind === 'file')
		return Result.isSuccess(Schema.decodeUnknownResult(inputSchema(after))(value))
			? value
			: undefined;
	if (
		before?.kind === 'money' &&
		after.kind === 'money' &&
		canonical(before.currency) !== canonical(after.currency)
	)
		return undefined;
	let converted = value;
	if (value !== null && before?.kind === 'ref') {
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
	} else if (after.kind === 'ref' && before?.kind !== 'ref' && value !== null) return undefined;
	else if (value !== null && numeric.has(after.kind)) {
		const scalar =
			Predicate.isObject(value) && typeof value['$dec'] === 'string' ? value['$dec'] : value;
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
								? minorDigits(after.currency)
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
				if (Decimal.of(String(scalar)).abs().gte(limit)) return undefined;
			}
			converted = { $dec: String(scalar) };
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
				((after.kind === 'int' && after.storage !== 'int64') ||
					after.kind === 'duration' ||
					after.kind === 'count') &&
				(n < -2147483648 || n > 2147483647)
			)
				return undefined;
			if (after.kind !== 'number' && !/^-?\d+(\.0+)?$/.test(String(scalar))) return undefined;
			converted = n;
		}
	} else if (
		after.kind === 'text' &&
		after.many !== true &&
		before !== undefined &&
		numeric.has(before.kind)
	) {
		converted =
			Predicate.isObject(value) && typeof value['$dec'] === 'string'
				? value['$dec']
				: value === null
					? null
					: String(value);
	}
	const decoded = decodeInput({ value: after }, { value: converted }, customFields);
	if (decoded.problems.length > 0 || decoded.value === undefined) return undefined;
	const encoded = encodeWire(decoded.value);
	return Predicate.isObject(encoded) ? encoded['value'] : undefined;
}

/** Materialize physical columns only at the restore boundary; the historical view uses its original logical fields. */
export function historyColumns(
	kind: FieldSpec | undefined,
	field: string,
	value: Json
): Readonly<Record<string, Json>> {
	if (kind?.kind === 'ref' && typeof kind.to !== 'string' && kind.to.length === 1)
		return { [field]: Predicate.isObject(value) ? (value['id'] ?? null) : value };
	if (kind?.kind === 'ref' && typeof kind.to !== 'string' && kind.to.length > 1)
		return Object.fromEntries(
			kind.to.map((target) => [
				`${field}__${target}`,
				Predicate.isObject(value) && value['model'] === target ? (value['id'] ?? null) : null
			])
		);
	if (kind?.kind === 'point' && Predicate.isObject(value))
		return { [field]: `(${value['lng']},${value['lat']})` };
	if (kind?.kind === 'period' && Predicate.isObject(value)) {
		if (kind.of === 'date') return { [field]: `[${value['from']},${value['to'] ?? ''}]` };
		return { [field]: `["${value['start']}",${value['end'] === null ? '' : `"${value['end']}"`})` };
	}
	return {
		[field]: Predicate.isObject(value) && typeof value['$dec'] === 'string' ? value['$dec'] : value
	};
}
