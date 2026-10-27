import { getContext, setContext } from 'svelte';
import type { ViewBolt } from '../client/contract.js';
import { BOLT } from '../client/context.js';
import { enumText } from '../kinds/kind.js';
import { label } from '../text/messages.js';
const MODEL = Symbol('ui.views.model');
/** The model the values beneath belong to (a Table's, a record's, a Form's): their enum words read its catalog keys. */
export const provideModel = (of: () => string) => setContext(MODEL, of);
/** The model named by the nearest `provideModel`, or `undefined` outside one. */
export const useModelKey = (): string | undefined =>
	getContext<(() => string) | undefined>(MODEL)?.();
/**
 * An enum or state value's words beneath a view: `models.<c>.fields.<field>.<value>` through the page's `t` when a
 * shell and a model are above, else the value in words (`enumText`). Call it at a component's init.
 */
export function useEnumText(): (value: string, field?: string) => string {
	const bolt = getContext<ViewBolt | undefined>(BOLT),
		of = getContext<(() => string) | undefined>(MODEL);
	return (value, field) =>
		enumText(value, {
			...(bolt === undefined ? {} : { t: (k: string) => bolt.t(k) }),
			...(of === undefined ? {} : { model: of() }),
			...(field === undefined ? {} : { field })
		});
}
/** A field's label beneath a view: the catalog's `models.<c>.fields.<field>`, else `declared`, else the name in words. */
export function useFieldLabel(): (field: string, declared?: string) => string {
	const bolt = getContext<ViewBolt | undefined>(BOLT),
		of = getContext<(() => string) | undefined>(MODEL);
	return (field, declared) => label(bolt ?? { t: (k) => k }, of?.() ?? '', field, declared);
}
