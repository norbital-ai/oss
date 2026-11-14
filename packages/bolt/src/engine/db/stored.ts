import { Array as EffectArray, BigDecimal, Option, Predicate, Schema } from 'effect';
import { q } from '@norbital-ai/store';
import { decimal_text, equal_json } from '@norbital-ai/store/kind';

import type { Catalog, FieldInfo } from '@norbital-ai/store';
import type { Json } from '../../decl/values.ts';
import type { Captured, RowData } from '../contracts.ts';
import { parse, storedInstant } from '@norbital-ai/host-api';
import { jsonbOrder, literal } from './wire.ts';

const textColumn = (field: FieldInfo) => field.pg === 'numeric' || field.pg === 'int8';
const objectSql = (entries: readonly string[]): string => Array.from(
	{ length: Math.ceil(entries.length / 100) },
	(_, index) => `jsonb_build_object(${entries.slice(index * 100, index * 100 + 100).join(', ')})`
).join(' || ');

/** Keep exact numeric text before a composed row crosses JSON. Native arrays stay arrays. */
export function storedRowSql(cat: Catalog, model: string, alias: string): string {
	const entries = [`'id'`, `${alias}.id::text`];
	for (const field of cat.models.get(model)?.fields.values() ?? [])
		if (field.name !== 'id' && textColumn(field))
			entries.push(literal(field.column), `${alias}.${q(field.column)}::text`);
	return `(to_jsonb(${alias}) || ${objectSql(entries)})`;
}

/** The same stored columns when the write compiler already holds a native JSON image. */
export function storedImageSql(cat: Catalog, models: readonly string[], image: string): string {
	const arms = models.flatMap((model) => {
		const entries = [...(cat.models.get(model)?.fields.values() ?? [])]
			.filter((field) => textColumn(field) && field.computed !== true)
			.flatMap((field) => [literal(field.column), `${image}->>${literal(field.column)}`]);
		return entries.length === 0 ? [] : [`WHEN c = ${literal(model)} THEN ${image} || ${objectSql(entries)}`];
	});
	return arms.length === 0 ? image : `CASE WHEN ${image} IS NULL THEN NULL ${arms.join(' ')} ELSE ${image} END`;
}

// PostgreSQL parses fractional seconds as a double and rounds microseconds to the nearest even integer.
const fractionMicros = (digits: string): number => {
	const value = Number(`0.${digits}`) * 1_000_000, whole = Math.floor(value);
	return value - whole === 0.5 ? whole + whole % 2 : Math.round(value);
};
export const instantOrder = (value: Json | undefined): bigint | undefined => {
	const normalized = typeof value === 'string' ? storedInstant(value) : undefined;
	if (normalized === undefined || !Number.isFinite(Date.parse(normalized))) return undefined;
	const fraction = /\.(\d+)/.exec(normalized)?.[1] ?? '';
	return (BigInt(Math.floor(Date.parse(normalized) / 1000)) * 1_000_000n + BigInt(fractionMicros(fraction))) * 1000n;
};
const timeOrder = (value: Json): number | undefined => {
	const parts = typeof value === 'string' ? /^(\d\d):(\d\d)(?::(\d\d)(?:\.(\d+))?)?$/.exec(value) : null;
	const hour = parts?.[1], minute = parts?.[2];
	if (hour === undefined || minute === undefined) return undefined;
	const h = Number(hour), m = Number(minute), s = Number(parts?.[3] ?? 0);
	const at = ((h * 60 + m) * 60 + s) * 1_000_000 + fractionMicros(parts?.[4] ?? '');
	return h <= 24 && m < 60 && s <= 60 && at <= 86_400_000_000 ? at : undefined;
};
const day = (value: string, delta: number): string | undefined => {
	const at = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(at) ? new Date(at + delta * 86_400_000).toISOString().slice(0, 10) : undefined;
};
const range = (value: string) => {
	const match = /^([[(])("[^"]*"|[^,]*),("[^"]*"|[^,]*)([\])])$/.exec(value);
	const lower = match?.[1], from = match?.[2], to = match?.[3], upper = match?.[4];
	return lower === undefined || from === undefined || to === undefined || upper === undefined ? undefined : {
		lower, upper, from: from.replace(/^"|"$/g, ''), to: to.replace(/^"|"$/g, '')
	};
};
const Vector = Schema.fromJsonString(Schema.Array(Schema.Finite));

/** One physical value, whether it arrived from a native row or a decoded wire value. */
function stored_value(field: Pick<FieldInfo, 'pg'>, value: Json): Json {
	if (value === null) return null;
	switch (field.pg) {
		case 'numeric': {
			if (typeof value === 'number' && Number.isFinite(value)) return decimal_text(BigDecimal.fromNumberUnsafe(value));
			return typeof value === 'string' && /^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(value) ? value.replace(/^\+/, '') : value;
		}
		case 'int8':
			return typeof value === 'string' && /^-?\d+$/.test(value) ? parse(20, value) : value;
		case 'timestamptz': {
			const at = instantOrder(value);
			if (at === undefined) return value;
			const micros = at / 1000n, millis = (micros < 0n ? (micros - 999n) / 1000n : micros / 1000n);
			const tail = (micros - millis * 1000n).toString().padStart(3, '0').replace(/0+$/, '');
			return `${new Date(Number(millis)).toISOString().slice(0, -1)}${tail}Z`;
		}
		case 'time': {
			const at = timeOrder(value);
			if (at === undefined) return value;
			const seconds = Math.floor(at / 1_000_000), fraction = String(at % 1_000_000).padStart(6, '0').replace(/0+$/, '');
			return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
				.map((part) => String(part).padStart(2, '0')).join(':') + (fraction === '' ? '' : `.${fraction}`);
		}
		case 'vector': {
			const vector = typeof value === 'string' ? Option.getOrUndefined(Schema.decodeUnknownOption(Vector)(value)) : value;
			return EffectArray.isArray<typeof vector>(vector) && vector.every((item) => typeof item === 'number' && Number.isFinite(item)) ? JSON.stringify(vector) : value;
		}
		case 'point': {
			const pair = typeof value === 'string' ? /^\(([^,]+),([^)]+)\)$/.exec(value) : undefined;
			const lng = pair?.[1] === undefined ? Predicate.isObject(value) ? value['lng'] : undefined : Number(pair[1]);
			const lat = pair?.[2] === undefined ? Predicate.isObject(value) ? value['lat'] : undefined : Number(pair[2]);
			return typeof lng === 'number' && typeof lat === 'number' && Number.isFinite(lng) && Number.isFinite(lat) ? `(${lng},${lat})` : value;
		}
		case 'daterange': case 'tstzrange': {
			const period = typeof value === 'string' ? range(value) : undefined;
			const date = field.pg === 'daterange';
			const from = period?.from ?? (Predicate.isObject(value) ? value[date ? 'from' : 'start'] : undefined);
			const to = period?.to ?? (Predicate.isObject(value) ? value[date ? 'to' : 'end'] : undefined);
			if (typeof from !== 'string' || (to != null && typeof to !== 'string')) return value;
			if (date) {
				const lower = day(from, period?.lower === '(' ? 1 : 0);
				const upper = to == null || to === '' ? '' : day(to, period === undefined || period.upper === ']' ? 1 : 0);
				return lower === undefined || upper === undefined ? value : `[${lower},${upper})`;
			}
			const lower = stored_value({ pg: 'timestamptz' }, from), upper = to == null || to === '' ? '' : stored_value({ pg: 'timestamptz' }, to);
			if (typeof lower !== 'string' || typeof upper !== 'string') return value;
			return `${period?.lower ?? '['}"${lower}",${upper === '' ? '' : `"${upper}"`}${period?.upper ?? ')'}`;
		}
		default: return value;
	}
}

/** Exact numeric values share the same native/wire normalization as stored cells. */
export function storedDecimal(value: Json | undefined): BigDecimal.BigDecimal | undefined {
	if (value == null) return undefined;
	const stored = stored_value({ pg: 'numeric' }, value);
	return typeof stored === 'string' ? Option.getOrUndefined(BigDecimal.fromString(stored)) : undefined;
}

/** Range bounds before the public timestamp projection drops fractional digits. */
export function storedRange(field: Pick<FieldInfo, 'pg'>, value: Json | undefined) {
	if (value == null) return undefined;
	const stored = stored_value(field, value);
	return typeof stored === 'string' ? range(stored) : undefined;
}

/** Scalar order before display projection; undefined asks the reader to decide. Null ordering belongs to the caller. */
export function storedOrder(field: Pick<FieldInfo, 'pg'>, left: Json | undefined, right: Json | undefined): number | undefined {
	if (left == null || right == null) return undefined;
	switch (field.pg) {
		case 'numeric': case 'int8': case 'int4': case 'int2': {
			if (field.pg !== 'numeric' && [left, right].some((value) => typeof value === 'number' && !Number.isSafeInteger(value))) return undefined;
			const a = storedDecimal(left), b = storedDecimal(right);
			return a === undefined || b === undefined ? undefined : BigDecimal.Order(a, b);
		}
		case 'float8': case 'float4': {
			const a = left, b = right;
			if ((typeof a !== 'number' && typeof a !== 'string') || (typeof b !== 'number' && typeof b !== 'string')) return undefined;
			const x = Number(a), y = Number(b);
			return Number.isFinite(x) && Number.isFinite(y) ? x < y ? -1 : x > y ? 1 : 0 : undefined;
		}
		case 'timestamptz': {
			const a = instantOrder(left), b = instantOrder(right);
			return a === undefined || b === undefined ? undefined : a < b ? -1 : a > b ? 1 : 0;
		}
		case 'bool':
			return typeof left === 'boolean' && typeof right === 'boolean' ? left === right ? 0 : left ? 1 : -1 : undefined;
		case 'time': {
			const a = timeOrder(left), b = timeOrder(right);
			return a === undefined || b === undefined ? undefined : a < b ? -1 : a > b ? 1 : 0;
		}
		case 'uuid': case 'text': case 'date': {
			if (typeof left !== 'string' || typeof right !== 'string') return undefined;
			const a = field.pg === 'uuid' ? left.toLowerCase() : left, b = field.pg === 'uuid' ? right.toLowerCase() : right;
			return a < b ? -1 : a > b ? 1 : 0;
		}
		default: return undefined;
	}
}

const cells = (name: string, value: Json, field?: FieldInfo): readonly (readonly [string, Json])[] => {
	if (field === undefined) return [[name, value]];
	if (field.arms === undefined) {
		const scalar = field.kind === 'id' && field.of !== undefined && Predicate.isObject(value) && value['model'] === field.of ? value['id'] ?? null : value;
		return [[field.column, stored_value(field, scalar)]];
	}
	return field.arms.map((arm): readonly [string, Json] => [`${field.column}__${arm}`,
		Predicate.isObject(value) && value['model'] === arm ? value['id'] ?? null : null]);
};
/** Canonical stored rows use physical columns; business JSON is never interpreted as a scalar tag. */
export function storedRow(cat: Catalog, model: string, row: RowData): RowData {
	const fields = cat.models.get(model)?.fields;
	const entries = Object.entries(row).flatMap(([name, value]) => cells(name, value, fields?.get(name)));
	return entries.length === Object.keys(row).length && entries.every(([name, value]) => Object.hasOwn(row, name) && row[name] === value)
		? row : Object.fromEntries(entries);
}

/** A captured image's stored row; a numeric cell that arrives as a JSON number (an approval image) has lost its scale
 * (`1.20` → 1.2) and stays a number, which no live projection takes. */
function capturedRow(cat: Catalog, model: string, row: RowData): RowData {
	const stored = storedRow(cat, model, row), fields = cat.models.get(model)?.fields;
	const lost = Object.entries(row).flatMap(([name, value]) => {
		const field = fields?.get(name);
		return field?.pg === 'numeric' && field.arms === undefined && typeof value === 'number' ? [[field.column, value] as const] : [];
	});
	return lost.length === 0 ? stored : { ...stored, ...Object.fromEntries(lost) };
}
/** Native and authored commits cross the same stored-image boundary. */
export const storedCaptures = (cat: Catalog, captured: readonly Captured[]): readonly Captured[] => captured.map((row) => {
	const old = row.old === null ? null : capturedRow(cat, row.model, row.old);
	const next = row.new === null ? null : capturedRow(cat, row.model, row.new);
	return old === row.old && next === row.new ? row : { ...row, old, new: next };
});

/** Compare the actual physical cells while retaining the caller's logical field names. */
export function storedChanges(cat: Catalog, model: string, row: RowData, set: RowData): RowData {
	const before = storedRow(cat, model, row), fields = cat.models.get(model)?.fields;
	return Object.fromEntries(Object.entries(set).filter(([name, value]) => {
		const field = fields?.get(name);
		return cells(name, value, field).some(([column, next]) => {
			const previous = before[column] ?? null;
			if (field?.pg === 'numeric' && previous !== null && next !== null) {
				const left = storedDecimal(previous), right = storedDecimal(next);
				if (left !== undefined && right !== undefined) return !BigDecimal.equals(left, right);
			}
			return !equal_json(previous, next);
		});
	}));
}

/** A physical value projected exactly as the read compiler's wire column. */
export function storedWireValue(field: Pick<FieldInfo, 'pg'>, value: Json | undefined): Json | undefined {
	if (value === undefined || value === null) return value;
	const stored = stored_value(field, value);
	switch (field.pg) {
		case 'numeric': {
			return storedDecimal(stored) === undefined ? undefined : stored;
		}
		case 'timestamptz': return typeof stored === 'string' && Number.isFinite(Date.parse(stored)) ? new Date(stored).toISOString() : undefined;
		case 'vector': return typeof stored === 'string' ? Option.getOrUndefined(Schema.decodeUnknownOption(Vector)(stored)) : undefined;
		case 'point': {
			const point = typeof stored === 'string' ? /^\(([^,]+),([^)]+)\)$/.exec(stored) : undefined;
			if (point?.[1] === undefined || point[2] === undefined) return undefined;
			const lat = Number(point[2]), lng = Number(point[1]);
			return Number.isFinite(lat) && Number.isFinite(lng) ? jsonbOrder({ lat, lng }) : undefined;
		}
		case 'daterange': case 'tstzrange': {
			const period = storedRange(field, stored);
			if (period === undefined) return undefined;
			if (field.pg === 'daterange') {
				const to = period.to === '' ? null : day(period.to, -1);
				return to === undefined ? undefined : jsonbOrder({ from: period.from, to });
			}
			const start = storedWireValue({ pg: 'timestamptz' }, period.from);
			const end = period.to === '' ? null : storedWireValue({ pg: 'timestamptz' }, period.to);
			return start === undefined || end === undefined ? undefined : jsonbOrder({ start, end });
		}
		default: return stored;
	}
}

/** A logical field read from its physical cells, including exclusive reference arms. */
export function storedField(field: FieldInfo, row: RowData): Json | undefined {
	if (field.arms === undefined) return storedWireValue(field, row[field.column]);
	if (field.arms.some((arm) => row[`${field.column}__${arm}`] === undefined)) return undefined;
	const arm = field.arms.find((arm) => row[`${field.column}__${arm}`] !== null);
	const id = arm === undefined ? undefined : row[`${field.column}__${arm}`];
	return arm === undefined ? null : typeof id === 'string' ? jsonbOrder({ model: arm, id }) : undefined;
}
