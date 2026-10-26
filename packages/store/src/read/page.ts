// A read statement's rows (`j` each, in wire form) → its answer: a page with its cursor, one row, or an aggregate.
// The database already stopped at the byte budget (`$over`); past a cap nothing is clamped — the read is refused.
import { Array as EffectArray, Effect } from 'effect';
import type { Json } from '../values.ts';
import type { ReadIR, SelectIR } from '../ir.ts';
import { StoreError } from '../errors.ts';
import { STORE_LIMITS } from '../limits.ts';
import { encodeCursor, OVER, type Compiled } from './sql.ts';

type Wire = { readonly [k: string]: Json };
const tooLarge = (message: string) => Effect.fail(StoreError.of('tooLarge', 'deliver', message));
const isWire = (v: Json): v is Wire =>
	v !== null && typeof v === 'object' && !EffectArray.isArray<typeof v>(v);
const cursorKeys = (v: Json | undefined): readonly (string | null)[] =>
	EffectArray.isArray<typeof v>(v) ? v.map((x) => (typeof x === 'string' ? x : null)) : [];

/** A many-relation arm asked for `all` holds at most `STORE_LIMITS.page.relationArm` rows, at any depth. */
export const armsFit = (ir: ReadIR, rows: readonly Wire[]): Effect.Effect<void, StoreError> => {
	if (ir.kind !== 'read' && ir.kind !== 'get') return Effect.void;
	const over = (sel: SelectIR, rs: readonly Wire[]): string | undefined => {
		for (const [rel, r] of Object.entries(sel.relations))
			for (const row of rs) {
				const v = row[rel];
				const list = (
					r.many
						? EffectArray.isArray<typeof v>(v)
							? v
							: []
						: v === null || v === undefined
							? []
							: [v]
				).filter(isWire);
				if (r.many && r.page?._tag === 'All' && list.length > STORE_LIMITS.page.relationArm)
					return rel;
				const deeper =
					r.targets === undefined
						? over(r.select, list)
						: r.targets
								.map((target) =>
									over(
										r.targetSelects?.[target] ?? r.select,
										list.filter((item) => item['collection'] === target)
									)
								)
								.find((name) => name !== undefined);
				if (deeper !== undefined) return deeper;
			}
		return undefined;
	};
	const rel = over(ir.select, rows);
	return rel === undefined
		? Effect.void
		: tooLarge(
				`relation '${rel}' holds more than ${STORE_LIMITS.page.relationArm} rows; state a limit (rule 9)`
			);
};

/** The answer of a compiled `read`, `get` or `aggregate`: `{ rows, next }`, a row or `null`, or the aggregate. */
export const answer = Effect.fnUntraced(function* (
	ir: ReadIR,
	c: Compiled,
	rows: readonly Json[],
	allBytes: number = STORE_LIMITS.page.allBytes
) {
	const answered = rows.filter(isWire);
	// the database stopped at the read's byte budget (`budgeted`): the marker is no row
	const over = answered.at(-1)?.[OVER] === true;
	const js = over ? answered.slice(0, -1) : answered;
	const of = ` of ${ir.collection}`;
	yield* armsFit(ir, js);
	if (c.kind === 'one' || c.kind === 'agg') {
		const one: Json = js[0] ?? null;
		return one;
	}
	if (c.limit === 'all' || c.limit === null) {
		if (js.length > STORE_LIMITS.page.all)
			return yield* tooLarge(
				`the read${of} matches more than ${STORE_LIMITS.page.all} rows; page it (rule 9)`
			);
		if (over)
			return yield* tooLarge(`the read${of} is larger than ${allBytes} bytes; page it (rule 9)`);
		const all: Json = { rows: [...js], next: null };
		return all;
	}
	// a page ends early at its byte budget, its cursor after the last row that fits
	if (over && js.length === 0)
		return yield* tooLarge(
			`a row${of} is larger than ${STORE_LIMITS.pageBytes} bytes; select fewer fields (rule 9)`
		);
	const more = over || js.length > c.limit;
	const page = js.slice(0, c.limit);
	const last = page.at(-1);
	const next = more && last !== undefined ? encodeCursor(c.hash, cursorKeys(last['$k'])) : null;
	const paged: Json = {
		rows: page.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== '$k'))),
		next
	};
	return paged;
});
