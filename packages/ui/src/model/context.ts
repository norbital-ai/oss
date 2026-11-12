import { getContext, setContext } from 'svelte';
import type { UiContext } from '../client/contract.js';
import { enum_text } from '../kinds/kind.js';
import { label } from '../text/messages.js';
const MODEL = Symbol('ui.views.model');
const FIELD_TEXT = Symbol('ui.views.field_text');
/** The catalogue prefix of generated fields, such as a model or an automation's input. */
export const provide_field_text = (prefix: () => string) => setContext(FIELD_TEXT, prefix);
/** The model the values beneath belong to (a Table's, a record's, a Form's): their enum words read its catalog keys. */
export const provide_model = (of: () => string) => {
	provide_field_text(() => `models.${of()}`);
	return setContext(MODEL, of);
};
/** The model named by the nearest `provide_model`, or `undefined` outside one. */
export const use_model_key = (): string | undefined =>
	getContext<(() => string) | undefined>(MODEL)?.();
/**
 * An enum or state value's words beneath a view: `models.<c>.fields.<field>.<value>` through the page's `t` when a
 * view client and a model are above, else the value in words (`enum_text`). Call it at a component's init.
 */
export function use_enum_text(ctx: () => UiContext): (value: string, field?: string) => string {
	const of = getContext<(() => string) | undefined>(MODEL);
	return (value, field) => {
		const client = ctx().ui.bolt;
		return enum_text(value, {
			...(client === undefined ? {} : { t: (k: string) => client.t(k) }),
			...(of === undefined ? {} : { model: of() }),
			...(field === undefined ? {} : { field })
		});
	};
}
/** A field's label beneath a view: the catalog's `models.<c>.fields.<field>`, else `declared`, else the name in words. */
export function use_field_label(ctx: () => UiContext): (field: string, declared?: string) => string {
	const of = getContext<(() => string) | undefined>(MODEL),
		prefix = getContext<(() => string) | undefined>(FIELD_TEXT);
	return (field, declared) => {
		const key = `${prefix?.() ?? `models.${of?.() ?? ''}`}.fields.${field}`;
		const text = ctx().ui.bolt?.t(key) ?? key;
		return text !== key ? text : label({ t: (k) => k }, of?.() ?? '', field, declared);
	};
}
/** Help text follows the same field namespace, under its `help` map. */
export function use_field_help(
	ctx: () => UiContext
): (field: string, declared?: string) => string | undefined {
	const of = getContext<(() => string) | undefined>(MODEL),
		prefix = getContext<(() => string) | undefined>(FIELD_TEXT);
	return (field, declared) => {
		const key = `${prefix?.() ?? `models.${of?.() ?? ''}`}.help.${field}`;
		const text = ctx().ui.bolt?.t(key) ?? key;
		return text !== key ? text : declared;
	};
}
