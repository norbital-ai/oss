import {
	type LocaleCatalogs,
	type KeysOf,
	type MessageVars,
	translate
} from './catalog.js';
import { type Locale, DEFAULT_LOCALE, INTL_LOCALE } from './locale.js';

export type { LocaleCatalogs, MessageCatalog, MessageVars, KeysOf } from './catalog.js';
export { defineMessages, translate, interpolate, intlLocale, hasKey } from './catalog.js';
export type { Locale } from './locale.js';
export {
	LOCALES,
	DEFAULT_LOCALE,
	INTL_LOCALE,
	STORED_LOCALE_KEY,
	isLocale,
	parseLocale,
	pickLocale,
	storedLocale,
	storeLocale,
	setHtmlLang
} from './locale.js';

/** A locale-aware translation function, typed over the catalog key union. */
export type TranslateFn<Keys extends string = string> = (
	key: Keys,
	vars?: MessageVars
) => string;

/**
 * The non-reactive translation runtime: a catalog pair plus an explicit
 * locale, translated on demand.
 *
 * Svelte surfaces wrap this in reactive state (see `@norbital-ai/ui/i18n`);
 * server code can use this directly, selecting the locale per request.
 */
export interface I18nRuntime<Keys extends string = string> {
	/** The active application locale. */
	readonly locale: Locale;
	/** The `Intl.*` locale string for the active locale (`en-US` / `zh-CN`). */
	readonly intlLocale: string;
	/** Translate a typed key, with `{placeholder}` interpolation. */
	readonly t: TranslateFn<Keys>;
	/** True when the key exists in either locale of the catalog pair. */
	has(key: string): boolean;
	/** Switch the active locale. */
	setLocale(locale: Locale): void;
}

/**
 * Create a translation runtime over a catalog pair.
 *
 * Not reactive on its own: consumers that need reactivity (Svelte) hold the
 * locale in `$state` and call `translate` through their own wrapper; this
 * runtime is for server code and one-off lookups.
 */
export function createI18n<C extends LocaleCatalogs>(
	catalogs: C,
	initialLocale: Locale = DEFAULT_LOCALE
): I18nRuntime<KeysOf<C>> {
	let locale: Locale = initialLocale;
	const api: I18nRuntime<KeysOf<C>> = {
		get locale() {
			return locale;
		},
		get intlLocale() {
			return INTL_LOCALE[locale];
		},
		t(key, vars) {
			return translate(catalogs, locale, key, vars);
		},
		has(key) {
			return key in catalogs.en || key in catalogs.zh;
		},
		setLocale(next: Locale) {
			locale = next;
		}
	};
	return api;
}
