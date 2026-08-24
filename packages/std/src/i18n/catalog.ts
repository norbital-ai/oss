import { DEFAULT_LOCALE } from './locale.js';

/**
 * Flat, dot-namespaced message catalogs.
 *
 * A catalog is a flat `Record<string, string>`; namespacing is a key
 * convention (`table.emptyState`, `form.required`), never nested structure, so
 * catalogs merge and override by spread with no shape surprises.
 *
 * A catalog record carries every supported locale. `defineMessages` enforces
 * exact key parity between locales: the runtime falls back locale -> primary
 * (`DEFAULT_LOCALE`) -> key, and `KeysOf` intersects the per-locale key sets,
 * so a key missing from any locale is a compile-time error at the first
 * `t(...)` call. English is the source of truth.
 */
export type MessageCatalog = Readonly<Record<string, string>>;

/** A complete set of message catalogs, keyed by application locale. */
export type LocaleCatalogs = Readonly<Record<string, MessageCatalog>>;

/** Interpolation variables for a message template. */
export type MessageVars = Readonly<Record<string, string | number>>;

/**
 * Extract the key union of a catalog set, for typing `t`.
 *
 * The intersection over the per-locale key sets: with parity this is the
 * shared key set, and a key missing from any locale drops out of the union and
 * becomes a compile-time error at its call site.
 */
export type KeysOf<C extends LocaleCatalogs> = keyof C[keyof C] & string;

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
 * Define a set of message catalogs with exact key parity between locales.
 *
 * The primary catalog (keyed by `DEFAULT_LOCALE`, conventionally `en`) is the
 * source of truth; every other locale must carry exactly the same keys, which
 * `KeysOf` enforces at compile time. The runtime check keeps a mismatched
 * catalog from silently shipping when the type contract is bypassed (e.g. a
 * JSON round trip).
 */
export function defineMessages<const C extends LocaleCatalogs>(catalogs: C): C {
	const entries = Object.entries(catalogs);
	const [primaryLocale, primary] = entries[0] ?? [null, null];
	if (primaryLocale == null || primary == null) {
		throw new Error('defineMessages requires at least one locale catalog');
	}
	for (const [locale, catalog] of entries.slice(1)) {
		for (const key of Object.keys(primary)) {
			if (!(key in catalog)) {
				throw new Error(
					`Catalog "${locale}" is missing key "${key}" present in "${primaryLocale}"`
				);
			}
		}
		for (const key of Object.keys(catalog)) {
			if (!(key in primary)) {
				throw new Error(
					`Catalog "${locale}" has extra key "${key}" not present in "${primaryLocale}"`
				);
			}
		}
	}
	return catalogs;
}

/**
 * Pure lookup: translate `key` in `locale`, falling back locale -> primary -> key.
 */
export function translate(
	catalogs: LocaleCatalogs,
	locale: string,
	key: string,
	vars?: MessageVars
): string {
	const template = catalogs[locale]?.[key] ?? catalogs[DEFAULT_LOCALE]?.[key] ?? key;
	return interpolate(template, vars);
}
