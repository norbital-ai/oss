// std/versioned (§3.7, §6.3 "Versioned lineage", PH GAP-4): pure helpers over the rows of the lineage recipe
// (`period`, `sealed_at`, `voided_at`, `void_reason`, sealed-only `no_overlap`). A sealed version never changes except
// for a shortened period (its successor was sealed) or one void with a reason; a correction is a new draft built by
// `clone_next` and sealed over the old version. The seal's write is held by the model's `update` grant (§3.8).
import { add_days, PlainDate, type DatePeriod, type Instant } from './date.ts';
import { equal_json } from './json.ts';
import { Schema } from 'effect';

/** The columns of a versioned row these helpers read. */
export type Lineage = {
	readonly id: string;
	readonly period: DatePeriod;
	readonly sealed_at?: Instant | string | null;
	readonly voided_at?: Instant | string | null;
	readonly void_reason?: string | null;
};
type Input = { readonly [field: string]: unknown };

const live = (v: Lineage) => v.sealed_at != null && v.voided_at == null;
const same = (a: unknown, b: unknown) => equal_json(a ?? null, b ?? null);
const period_of = (p: DatePeriod) => ({ from: p.from, to: p.to ?? null });
/** An update's `period` is caller input: a date period's ends as their ISO text. */
const isPeriod = Schema.is(
	Schema.Struct({ from: Schema.String, to: Schema.NullOr(Schema.String) })
);

/**
 * The one update list (X-24) that seals `draft`: the sealed version it follows ends the day before it starts, and the
 * draft ends the day before the next sealed version, so the sealed-only `no_overlap` holds in the one statement.
 */
export function seal_writes<V extends Lineage & { readonly revision: number }>(
	draft: V,
	sealed: readonly V[],
	now: Instant | string
): { target: V; set: { period: DatePeriod; sealed_at?: Instant | string } }[] {
	if (draft.sealed_at != null) throw new Error('This version is already sealed.');
	const others = sealed.filter((v) => v.id !== draft.id && live(v));
	const clash = others.find((v) => v.period.from === draft.period.from);
	if (clash)
		throw new Error(
			`A sealed version already starts on ${draft.period.from}; void it before sealing another from that day.`
		);
	const writes: { target: V; set: { period: DatePeriod; sealed_at?: Instant | string } }[] =
		[];
	const before = others.find(
		(v) =>
			v.period.from < draft.period.from &&
			(v.period.to === null || v.period.to >= draft.period.from)
	);
	if (before)
		writes.push({
			target: before,
			set: { period: { from: before.period.from, to: add_days(draft.period.from, -1) } }
		});
	const next = others
		.filter((v) => v.period.from > draft.period.from)
		.sort((a, b) => (a.period.from < b.period.from ? -1 : 1))[0];
	const to =
		next && (draft.period.to === null || draft.period.to >= next.period.from)
			? add_days(next.period.from, -1)
			: draft.period.to;
	writes.push({
		target: draft,
		set: { period: { from: draft.period.from, to }, sealed_at: now }
	});
	return writes;
}

/**
 * For a sealed version's update: null when every change is an earlier end of its period (or a void, which
 * `void_once` judges), else the refusal. Nested relation writes (its lines) are changes, so they are refused too.
 */
export function only_shortens(before: Lineage, input: Input): string | null {
	for (const [field, value] of Object.entries(input)) {
		if (field === 'voided_at' || field === 'void_reason' || same(value, (before as Input)[field]))
			continue;
		if (field === 'period' && isPeriod(value)) {
			const p = value,
				was = period_of(before.period);
			if (
				p.from === was.from &&
				p.to != null &&
				p.to >= p.from &&
				(was.to === null || p.to <= was.to)
			)
				continue;
		}
		return field === 'period'
			? 'A sealed version’s period may only end earlier. Seal a new version instead.'
			: `This version is sealed, so ${field} cannot change. Seal a corrected version instead; a wrong seal is voided.`;
	}
	return null;
}

/** For a sealed version's update: one void, with a reason, never undone or reworded; null when admitted. */
export function void_once(before: Lineage, input: Input): string | null {
	const voids = 'voided_at' in input,
		words = 'void_reason' in input;
	if (!voids && !words) return null;
	if (before.voided_at != null) {
		if (voids && !same(input['voided_at'], before.voided_at))
			return 'This version is voided; a void is never undone.';
		if (words && !same(input['void_reason'], before.void_reason))
			return 'This version is voided; its reason is part of the record.';
		return null;
	}
	if (input['voided_at'] == null)
		return words && !same(input['void_reason'], before.void_reason)
			? 'A reason is given only with a void.'
			: null;
	const reason = words ? input['void_reason'] : before.void_reason;
	return typeof reason === 'string' && reason.trim() !== '' ? null : 'A void states its reason.';
}

type Carried = 'id' | 'revision' | 'sealed_at' | 'voided_at' | 'void_reason' | 'period';
type Rows = { readonly [relation: string]: readonly { readonly [field: string]: unknown }[] };

/**
 * The create input of the successor draft: the version's own values (as the caller selected them) from `from`, open,
 * unsealed, with each relation's rows as explicit nested creates.
 */
export function clone_next<V extends Lineage, R extends Rows = {}>(
	version: V,
	from: PlainDate | string,
	children?: R
): Omit<V, Carried> & { period: DatePeriod } & {
	[K in keyof R]: { create: Omit<R[K][number], 'id' | 'revision'>[] };
} {
	const start = PlainDate(from);
	const strip = (row: { readonly [field: string]: unknown }, drop: readonly string[]) =>
		Object.fromEntries(Object.entries(row).filter(([k]) => !drop.includes(k)));
	const out: Record<string, unknown> = {
		...strip(version, ['id', 'revision', 'sealed_at', 'voided_at', 'void_reason']),
		period: { from: start, to: null }
	};
	for (const [rel, rows] of Object.entries(children ?? {}))
		out[rel] = { create: rows.map((r) => strip(r, ['id', 'revision'])) };
	return out as Omit<V, Carried> & { period: DatePeriod } & {
		[K in keyof R]: { create: Omit<R[K][number], 'id' | 'revision'>[] };
	};
}
