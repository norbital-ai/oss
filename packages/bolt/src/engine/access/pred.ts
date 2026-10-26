// Grant predicates: a grant's `Where` literal → `Pred` through the query area's normalizer (one K3 decode for reads and
// grants), the little Pred algebra the Authority compiler needs, and the JS judge of pre/post-images.
import type { EngineManifest } from '../manifest.ts';
import { storeSync } from '../../protocol/errors.ts';
import type { Pred } from '@norbital-ai/store';
import { catalog } from '../../protocol/catalog.ts';
import { type Catalog } from '@norbital-ai/store';
import { where } from '@norbital-ai/store';

export const TRUE: Pred = { t: 'const', value: true };
const FALSE: Pred = { t: 'const', value: false };
const isTrue = (p: Pred): boolean => p.t === 'const' && p.value;
export const or = (of: readonly Pred[]): Pred =>
	of.some(isTrue) ? TRUE : of.length === 0 ? FALSE : of.length === 1 ? of[0]! : { t: 'or', of };

const catalogs = new WeakMap<EngineManifest, Catalog>();
export function catalogOf(m: EngineManifest): Catalog {
	let cat = catalogs.get(m);
	if (cat === undefined) catalogs.set(m, (cat = catalog(m)));
	return cat;
}
/** A declared predicate (a grant, a route, a trigger's `where`), which `bolt check` proved, as the IR. */
export const toPred = (m: EngineManifest, model: string, w: unknown): Pred =>
	storeSync(where(catalogOf(m), model, w));
