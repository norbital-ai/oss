// Grant predicates: a grant's `Where` literal → `Pred` through the query area's normalizer (one K3 decode for reads and
// grants), the little Pred algebra the Authority compiler needs, and the JS judge of pre/post-images.
import { Effect } from 'effect';
import type { Where } from '@norbital-ai/store/kind';
import type { EngineManifest } from '../manifest.ts';
import { from_store, type BoltError } from '../../protocol/errors.ts';
import type { Pred } from '@norbital-ai/store';
import { catalog } from '../../protocol/catalog.ts';
import { type Catalog } from '@norbital-ai/store';
import { own_pred_sql, where, type Binder } from '@norbital-ai/store';

export const TRUE: Pred = { t: 'const', value: true };
const FALSE: Pred = { t: 'const', value: false };
const isTrue = (p: Pred): boolean => p.t === 'const' && p.value;
export const or = (of: readonly Pred[]): Pred => {
	const first = of[0];
	return of.some(isTrue) ? TRUE : of.length === 0 ? FALSE : of.length === 1 && first !== undefined ? first : { t: 'or', of };
};

const catalogs = new WeakMap<EngineManifest, Catalog>();
export function catalog_of(m: EngineManifest): Catalog {
	let cat = catalogs.get(m);
	if (cat === undefined) catalogs.set(m, (cat = catalog(m)));
	return cat;
}
/** A declared predicate (a grant, a route, a trigger's `where`), which `bolt check` proved, as the IR. */
export const toPred = (m: EngineManifest, model: string, w: Where): Effect.Effect<Pred, BoltError> =>
	where(catalog_of(m), model, w).pipe(Effect.mapError(from_store));
/** A declared predicate as SQL over one row of `model` (`own_pred_sql`'s `row`, `twoValued`). */
export const toOwnSql = (
	m: EngineManifest,
	model: string,
	w: Where,
	row: string,
	c: Binder,
	twoValued?: boolean
): Effect.Effect<string, BoltError> =>
	toPred(m, model, w).pipe(
		Effect.flatMap((p) => own_pred_sql(p, row, c, twoValued).pipe(Effect.mapError(from_store)))
	);
