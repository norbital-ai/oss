import type { InlinedTable, RoundingMethod } from './definition.js';

/** A single audit entry pushed by an op during evaluation. */
export type AuditEntry = { op: string; audit: unknown };

/** Mutable audit sink — ops push entries here as a side effect. */
export type AuditRef = { sink: AuditEntry[] };

/** CEL function signature string. */
export type OpSignature = string;

/** Spec for registering an op on the CEL environment. */
export type OpRegistration = { signature: OpSignature; handler: (...args: unknown[]) => unknown };

function toNumber(value: unknown): number {
	if (typeof value === 'number') return value;
	if (typeof value === 'bigint') return Number(value);
	if (typeof value === 'string') {
		const parsed = parseFloat(value);
		return Number.isNaN(parsed) ? 0 : parsed;
	}
	return 0;
}

function fieldValue(value: unknown, field: string): unknown {
	if (value == null || typeof value !== 'object') return undefined;
	return Reflect.get(value, field);
}

function completedYears(dob: unknown, asOf: unknown, dayOffset = 0): number {
	if (dob == null || dob === '' || asOf == null || asOf === '') return 0;
	const birth = new Date(String(dob));
	const reference = new Date(String(asOf));
	if (Number.isNaN(birth.getTime()) || Number.isNaN(reference.getTime())) return 0;
	reference.setUTCDate(reference.getUTCDate() + dayOffset);
	let age = reference.getUTCFullYear() - birth.getUTCFullYear();
	const monthDiff = reference.getUTCMonth() - birth.getUTCMonth();
	if (monthDiff < 0 || (monthDiff === 0 && reference.getUTCDate() < birth.getUTCDate())) {
		age--;
	}
	return age;
}

function roundMoney(value: number, method: RoundingMethod): number {
	if (method === 'NONE') return value;
	const epsilon = Number.EPSILON * Math.max(1, Math.abs(value)) * 4;
	if (method === 'TRUNCATE_CENT') {
		const scaled = value * 100;
		return Math.trunc(scaled + Math.sign(scaled) * epsilon) / 100;
	}
	if (method === 'UP_5_CENTS') return Math.ceil(value * 20 - epsilon) / 20;
	if (method === 'NEAREST_5_CENTS') return Math.round((value + epsilon) * 20) / 20;
	return Math.round((value + epsilon) * 100) / 100;
}

function parseRoundingMethod(value: unknown): RoundingMethod {
	const str = String(value ?? 'NONE');
	if (
		str === 'NEAREST_CENT' ||
		str === 'NEAREST_5_CENTS' ||
		str === 'TRUNCATE_CENT' ||
		str === 'UP_5_CENTS' ||
		str === 'NONE'
	)
		return str;
	return 'NONE';
}

type TableMap = Record<string, InlinedTable>;

function findTierRow(
	table: Extract<InlinedTable, { kind: 'tier' }>,
	value: number
): (typeof table.rows)[number] | null {
	let fallback: (typeof table.rows)[number] | null = null;
	for (const row of table.rows) {
		fallback = row;
		if (row.max === 0 || value <= row.max) return row;
	}
	return fallback;
}

/** Create all scalar (non-table) op registrations with an audit sink. */
export function createScalarOps(audit: AuditRef): OpRegistration[] {
	const clamp: OpRegistration = {
		signature: 'clamp(dyn, dyn, dyn): double',
		handler: (value, min, max) => {
			const v = toNumber(value);
			const lo = toNumber(min);
			const hi = toNumber(max);
			const clamped = Math.max(lo, Math.min(hi, v));
			audit.sink.push({
				op: 'clamp',
				audit: { min: lo, max: hi, before: v, after: clamped, clamped: v !== clamped }
			});
			return clamped;
		}
	};

	const round: OpRegistration = {
		signature: 'round(dyn, dyn): double',
		handler: (value, mode) => {
			const v = toNumber(value);
			const m = parseRoundingMethod(mode);
			const rounded = roundMoney(v, m);
			audit.sink.push({ op: 'round', audit: { mode: m, before: v, after: rounded } });
			return rounded;
		}
	};

	const ceilOp: OpRegistration = {
		signature: 'ceil(dyn): double',
		handler: (value) => {
			const v = toNumber(value);
			const result = Math.ceil(v);
			audit.sink.push({ op: 'ceil', audit: { before: v, after: result } });
			return result;
		}
	};

	const floorOp: OpRegistration = {
		signature: 'floor(dyn): double',
		handler: (value) => {
			const v = toNumber(value);
			const result = Math.floor(v);
			audit.sink.push({ op: 'floor', audit: { before: v, after: result } });
			return result;
		}
	};

	const minOp: OpRegistration = {
		signature: 'min(dyn): double',
		handler: (...args) => {
			const nums = (args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map(toNumber);
			const selected = Math.min(...nums);
			audit.sink.push({ op: 'min', audit: { values: nums, selected } });
			return selected;
		}
	};

	const minPair: OpRegistration = {
		signature: 'min(dyn, dyn): double',
		handler: (a, b) => {
			const va = toNumber(a);
			const vb = toNumber(b);
			const selected = Math.min(va, vb);
			audit.sink.push({ op: 'min', audit: { values: [va, vb], selected } });
			return selected;
		}
	};

	const minField: OpRegistration = {
		signature: 'min(dyn, string): double',
		handler: (list, field) => {
			const f = String(field);
			const nums = (Array.isArray(list) ? list : []).map((row) => toNumber(fieldValue(row, f)));
			const selected = Math.min(...nums);
			audit.sink.push({ op: 'min', audit: { field: f, values: nums, selected } });
			return selected;
		}
	};

	const maxOp: OpRegistration = {
		signature: 'max(dyn): double',
		handler: (...args) => {
			const nums = (args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map(toNumber);
			const selected = Math.max(...nums);
			audit.sink.push({ op: 'max', audit: { values: nums, selected } });
			return selected;
		}
	};

	const maxField: OpRegistration = {
		signature: 'max(dyn, string): double',
		handler: (list, field) => {
			const f = String(field);
			const nums = (Array.isArray(list) ? list : []).map((row) => toNumber(fieldValue(row, f)));
			const selected = Math.max(...nums);
			audit.sink.push({ op: 'max', audit: { field: f, values: nums, selected } });
			return selected;
		}
	};

	const sumList: OpRegistration = {
		signature: 'sum(dyn): double',
		handler: (list) => {
			const values = (Array.isArray(list) ? list : []).map(toNumber);
			const total = values.reduce((s, v) => s + v, 0);
			audit.sink.push({ op: 'sum', audit: { count: values.length, values, total } });
			return total;
		}
	};

	const sumField: OpRegistration = {
		signature: 'sum(dyn, string): double',
		handler: (list, field) => {
			const f = String(field);
			const values = (Array.isArray(list) ? list : []).map((row) => toNumber(fieldValue(row, f)));
			const total = values.reduce((s, v) => s + v, 0);
			audit.sink.push({ op: 'sum', audit: { field: f, count: values.length, values, total } });
			return total;
		}
	};

	const count: OpRegistration = {
		signature: 'count(dyn): double',
		handler: (list) => {
			const c = Array.isArray(list) ? list.length : 0;
			audit.sink.push({ op: 'count', audit: { count: c } });
			return c;
		}
	};

	const threshold: OpRegistration = {
		signature: 'threshold(dyn, dyn): double',
		handler: (value, min) => {
			const v = toNumber(value);
			const m = toNumber(min);
			const met = v >= m;
			audit.sink.push({ op: 'threshold', audit: { min: m, met } });
			return met ? 1 : 0;
		}
	};

	const pow: OpRegistration = {
		signature: 'pow(dyn, dyn): double',
		handler: (base, exp) => {
			const b = toNumber(base);
			const e = toNumber(exp);
			const result = Math.pow(b, e);
			audit.sink.push({ op: 'pow', audit: { base: b, exp: e, result } });
			return result;
		}
	};

	const sqrt: OpRegistration = {
		signature: 'sqrt(dyn): double',
		handler: (value) => {
			const v = toNumber(value);
			const result = Math.sqrt(v);
			audit.sink.push({ op: 'sqrt', audit: { value: v, result } });
			return result;
		}
	};

	const range: OpRegistration = {
		signature: 'range(dyn, dyn): dyn',
		handler: (start, end) => {
			const s = Math.round(toNumber(start));
			const e = Math.round(toNumber(end));
			const list: number[] = [];
			for (let i = s; i < e; i++) list.push(i);
			audit.sink.push({ op: 'range', audit: { start: s, end: e, count: list.length } });
			return list;
		}
	};

	const yearsOld: OpRegistration = {
		signature: 'yearsOld(dyn, dyn): double',
		handler: (dob, asOf) => {
			const birthRaw = dob == null || dob === '' ? null : String(dob);
			const refRaw = asOf == null || asOf === '' ? null : String(asOf);
			if (birthRaw == null || refRaw == null) {
				audit.sink.push({ op: 'yearsOld', audit: { dob: birthRaw, asOf: refRaw, age: 0 } });
				return 0;
			}
			const age = completedYears(birthRaw, refRaw);
			audit.sink.push({ op: 'yearsOld', audit: { dob: birthRaw, asOf: refRaw, age } });
			return age;
		}
	};

	const yearsOldOnPreviousDay: OpRegistration = {
		signature: 'yearsOldOnPreviousDay(dyn, dyn): double',
		handler: (dob, asOf) => {
			const age = completedYears(dob, asOf, -1);
			audit.sink.push({
				op: 'yearsOldOnPreviousDay',
				audit: { dob: String(dob ?? ''), asOf: String(asOf ?? ''), age }
			});
			return age;
		}
	};

	return [
		clamp,
		round,
		ceilOp,
		floorOp,
		minOp,
		minPair,
		maxOp,
		maxField,
		sumList,
		sumField,
		count,
		threshold,
		pow,
		sqrt,
		range,
		yearsOld,
		yearsOldOnPreviousDay
	];
}

/** Create table-dependent op registrations with an audit sink. */
export function createTableOps(tables: TableMap, audit: AuditRef): OpRegistration[] {
	const applyRate: OpRegistration = {
		signature: 'applyRate(dyn, string): double',
		handler: (base, tableName) => {
			const table = tables[String(tableName)];
			const v = toNumber(base);
			if (!table || table.kind !== 'tier') {
				audit.sink.push({
					op: 'applyRate',
					audit: { table: String(tableName), error: 'not a tier table' }
				});
				return 0;
			}
			const row = findTierRow(table, v);
			const rate = row?.rate ?? 0;
			const result = v * rate;
			audit.sink.push({
				op: 'applyRate',
				audit: { table: String(tableName), matchedRow: row, rate, base: v, result }
			});
			return result;
		}
	};

	const applyTier: OpRegistration = {
		signature: 'applyTier(dyn, string, string): double',
		handler: (value, tableName, key) => {
			const table = tables[String(tableName)];
			const v = toNumber(value);
			if (!table || table.kind !== 'tier') {
				audit.sink.push({
					op: 'applyTier',
					audit: { table: String(tableName), error: 'not a tier table' }
				});
				return 0;
			}
			const row = findTierRow(table, v);
			const colKey = String(key);
			const colValue = row?.[colKey];
			const result = typeof colValue === 'number' ? colValue : 0;
			audit.sink.push({
				op: 'applyTier',
				audit: { table: String(tableName), matchedRow: row, key: colKey, value: result }
			});
			return result;
		}
	};

	const applyProgressive: OpRegistration = {
		signature: 'applyProgressive(dyn, string): double',
		handler: (value, tableName) => {
			const table = tables[String(tableName)];
			const v = toNumber(value);
			if (!table || table.kind !== 'progressive') {
				audit.sink.push({
					op: 'applyProgressive',
					audit: { table: String(tableName), error: 'not a progressive table' }
				});
				return 0;
			}
			let previousMax = 0;
			for (const row of table.rows) {
				if (v <= row.max) {
					const base = row.base ?? 0;
					const slice = v - previousMax;
					const result = base + slice * row.rate;
					audit.sink.push({
						op: 'applyProgressive',
						audit: {
							table: String(tableName),
							matchedTier: { max: row.max, rate: row.rate, base },
							previousMax,
							slice,
							result
						}
					});
					return result;
				}
				previousMax = row.max;
			}
			audit.sink.push({
				op: 'applyProgressive',
				audit: { table: String(tableName), error: 'no matching tier' }
			});
			return 0;
		}
	};

	const lookup: OpRegistration = {
		signature: 'lookup(string, dyn): dyn',
		handler: (tableName, dims) => {
			const table = tables[String(tableName)];
			if (!table) {
				audit.sink.push({
					op: 'lookup',
					audit: { table: String(tableName), error: 'table not found' }
				});
				return null;
			}
			const dimensions =
				dims != null && typeof dims === 'object' && !Array.isArray(dims)
					? Object.fromEntries(Object.entries(dims))
					: {};

			if (table.kind === 'flat') {
				const matched = table.rows.find((row) =>
					Object.entries(dimensions).every(([k, v]) => row[k] === v)
				);
				audit.sink.push({ op: 'lookup', audit: { table: String(tableName), matchedRow: matched } });
				return matched ?? null;
			}

			if (table.kind === 'matrix') {
				const matched = table.rows.find((row) =>
					table.dimensions.every((dim) => {
						if (dim.kind === 'exact') return row[dim.name] === dimensions[dim.name];
						const dimValue = toNumber(dimensions[dim.name]);
						const rowMax = toNumber(row[`${dim.name}Max`]);
						return dimValue <= rowMax;
					})
				);
				audit.sink.push({ op: 'lookup', audit: { table: String(tableName), matchedRow: matched } });
				return matched ?? null;
			}

			if (table.kind === 'tier') {
				const firstDim = Object.keys(dimensions)[0];
				const v = toNumber(firstDim === undefined ? undefined : dimensions[firstDim]);
				const row = findTierRow(table, v);
				audit.sink.push({ op: 'lookup', audit: { table: String(tableName), matchedRow: row } });
				return row ?? null;
			}

			audit.sink.push({
				op: 'lookup',
				audit: { table: String(tableName), error: 'unsupported table kind' }
			});
			return null;
		}
	};

	return [applyRate, applyTier, applyProgressive, lookup];
}

/** Create the fold op. Needs env (for sub-expr eval), scope ref, and audit ref. */
export function createFoldOp(
	parseExpr: (expr: string) => (context: Record<string, unknown>) => unknown,
	scopeRef: { scope: Record<string, unknown> | null },
	audit: AuditRef
): OpRegistration {
	const foldCache = new Map<string, (context: Record<string, unknown>) => unknown>();

	return {
		signature: 'fold(dyn, list<dyn>, string): dyn',
		handler: (initial, list, exprStr) => {
			const s = String(exprStr);
			let compiled = foldCache.get(s);
			if (!compiled) {
				compiled = parseExpr(s);
				foldCache.set(s, compiled);
			}
			const arr = Array.isArray(list) ? list : [];
			const baseScope = scopeRef.scope ?? {};

			const outerSink = audit.sink;
			let acc: unknown = initial;
			const iterations: { input: unknown; output: unknown; ops: AuditEntry[] }[] = [];

			for (let i = 0; i < arr.length; i++) {
				const prev = acc;
				audit.sink = [];
				acc = compiled({ ...baseScope, acc, item: arr[i], index: i, list: arr });
				iterations.push({
					input: { acc: prev, item: arr[i], index: i },
					output: acc,
					ops: audit.sink
				});
			}
			audit.sink = outerSink;
			audit.sink.push({ op: 'fold', audit: { iterations } });
			return acc;
		}
	};
}
