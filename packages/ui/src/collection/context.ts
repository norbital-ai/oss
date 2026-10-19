import { getContext, setContext } from 'svelte';
import type { ViewBolt } from '../client/contract.js';
import { BOLT } from '../client/context.js';
import { enumText } from '../kinds/kind.js';
import { label } from '../text/messages.js';
const COLLECTION = Symbol('ui.views.collection');
/** The collection the values beneath belong to (a Table's, a record's, a Form's): their enum words read its catalog keys. */
export const provideCollection = (of: () => string) => setContext(COLLECTION, of);
/** The collection named by the nearest `provideCollection`, or `undefined` outside one. */
export const useCollectionKey = (): string | undefined =>
	getContext<(() => string) | undefined>(COLLECTION)?.();
/**
 * An enum or state value's words beneath a view: `models.<c>.fields.<field>.<value>` through the page's `t` when a
 * shell and a collection are above, else the value in words (`enumText`). Call it at a component's init.
 */
export function useEnumText(): (value: string, field?: string) => string {
	const bolt = getContext<ViewBolt | undefined>(BOLT),
		of = getContext<(() => string) | undefined>(COLLECTION);
	return (value, field) =>
		enumText(value, {
			...(bolt === undefined ? {} : { t: (k: string) => bolt.t(k) }),
			...(of === undefined ? {} : { collection: of() }),
			...(field === undefined ? {} : { field })
		});
}
/** A field's label beneath a view: the catalog's `models.<c>.fields.<field>`, else `declared`, else the name in words. */
export function useFieldLabel(): (field: string, declared?: string) => string {
	const bolt = getContext<ViewBolt | undefined>(BOLT),
		of = getContext<(() => string) | undefined>(COLLECTION);
	return (field, declared) => label(bolt ?? { t: (k) => k }, of?.() ?? '', field, declared);
}
