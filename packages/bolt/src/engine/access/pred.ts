// Grant predicates: a grant's `Where` literal → `Pred` through the query area's normalizer (one K3 decode for reads and
// grants), the little Pred algebra the Authority compiler needs, and the JS judge of pre/post-images.
import type { EngineManifest } from '../manifest.ts';
import type { Pred } from '../../protocol/ir-types.ts';
import { catalog, type Catalog } from '../../protocol/catalog.ts';
import { where } from '../../protocol/ir.ts';

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
export const toPred = (m: EngineManifest, model: string, w: unknown): Pred =>
	where(catalogOf(m), model, w);
