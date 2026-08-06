import { type Locale, INTL_LOCALE } from './locale.js';

/**
 * Flat, dot-namespaced message catalogs.
 *
 * A catalog is a flat `Record<string, string>`; namespacing is a key
 * convention (`table.emptyState`, `form.required`), never nested structure, so
 * catalogs merge and override by spread with no shape surprises.
 *
 * Every catalog has both supported locales, and `defineMessages` enforces at
 * compile time that the Chinese catalog carries exactly the keys the English
 * catalog carries. English is the source of truth; the runtime falls back
 * locale -> en -> key, so a future third language can be partial without
 * breaking the type contract.
 */
export type MessageCatalog = Readonly<Record<string, string>>;

/** A complete catalog pair for the supported locales. */
export type LocaleCatalogs = { readonly en: MessageCatalog; readonly zh: MessageCatalog };

/** Interpolation variables for a message template. */
export type MessageVars = Readonly<Record<string, string | number>>;

/** Extract the key union of a catalog pair, for typing `t`. */
export type KeysOf<C extends LocaleCatalogs> = keyof C['en'] & string;

const INTERPOLATION = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * Substitute `{name}` placeholders in a template.
 *
 * Unknown or null-ish variables interpolate as empty strings rather than
 * throwing: a missing variable is a copy bug, not a runtime failure worth
 * crashing a screen over.
 */
export function interpolate(template: string, vars?: MessageVars): string {
	if (!vars) return template;
	return template.replace(INTERPOLATION, (match, name: string) => {
		const value = vars[name];
		return value === undefined ? '' : String(value);
	});
}

/**
 * Define one message catalog pair with exact key parity between locales.
 *
 * The `zh` parameter's keys are checked against `en` at compile time; the
 * `satisfies` clause keeps `en` from widening to a bare `Record<string,string>`.
 */
export function defineMessages<const E extends MessageCatalog>(
	en: E,
	zh: { [K in keyof E]: string }
): { en: E; zh: { [K in keyof E]: string } } {
	return { en, zh };
}

/**
 * Pure lookup: translate `key` in `locale`, falling back locale -> en -> key.
 */
export function translate(
	catalogs: LocaleCatalogs,
	locale: Locale,
	key: string,
	vars?: MessageVars
): string {
	const template =
		catalogs[locale][key] ?? catalogs.en[key] ?? key;
	return interpolate(template, vars);
}

/** The Intl locale the catalog pair formats with, per application locale. */
export function intlLocale(locale: Locale): string {
	return INTL_LOCALE[locale];
}

/**
 * True when a key exists in either locale of the catalog pair.
 *
 * Lets callers distinguish "translated to the raw key" from "not in the
 * catalog at all" — e.g. label overrides that fall back to authored text when
 * a tenant did not supply one.
 */
export function hasKey(catalogs: LocaleCatalogs, key: string): boolean {
	return key in catalogs.en || key in catalogs.zh;
}
