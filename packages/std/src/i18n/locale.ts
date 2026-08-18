/**
 * Locale identifiers, BCP-47 parsing, and document/storage helpers for
 * Norbital's supported languages.
 *
 * The set of supported locales is deliberately closed and declared in exactly
 * one place (`SUPPORTED_LOCALES` below). Adding a language is a product
 * decision that touches every catalog in the system: extend this list, add the
 * matching `messages.<locale>.json` to the tenant compiler contract, and add
 * the Intl mapping — the runtime, catalogs, compiler, and the shell's language
 * toggle all derive their behavior from these declarations and need no other
 * edits.
 */

/** The supported application locales, in toggle order. English is the source-of-truth catalog. */
export const SUPPORTED_LOCALES: readonly string[] = ['en', 'zh'];

/**
 * The application locale identifier. Open by design: any catalog record may
 * carry any key, so `Locale` is the string it resolves to rather than a closed
 * union that would have to change in every package when a locale is added.
 */
export type Locale = string;

/** The fallback locale when no stored or detected choice exists. */
export const DEFAULT_LOCALE: Locale = 'en';

/** The Intl locale each application locale maps to for `Intl.*` formatting. */
export const INTL_LOCALES: Readonly<Record<string, string>> = {
	en: 'en-US',
	zh: 'zh-CN'
};

/**
 * The Intl locale string for an application locale, falling back to the raw
 * code so an unmapped locale still formats sensibly.
 */
export function intlLocale(locale: Locale): string {
	return INTL_LOCALES[locale] ?? locale;
}

/** Browser/localStorage key under which a viewer's locale choice is persisted. */
export const STORED_LOCALE_KEY = 'norbital.locale';

export function isLocale(value: unknown): value is Locale {
	return typeof value === 'string' && value.length > 0;
}

/**
 * Parse a BCP-47 tag into an application locale, or null.
 *
 * `zh-CN`, `zh-TW`, and `zh-Hans` all resolve to `zh`; anything whose primary
 * subtag is not a supported locale resolves to null. Malformed values resolve
 * to null — never to a guessed locale, so callers keep their fallback chain.
 */
export function parseLocale(value: string | null | undefined): Locale | null {
	if (value == null) return null;
	const primary = value.trim().split(/[-_]/)[0]?.toLowerCase();
	return isLocale(primary) ? primary : null;
}

/**
 * Pick the first supported locale from an ordered candidate list (typically
 * `navigator.languages` or an `Accept-Language` header).
 */
export function pickLocale(
	candidates: readonly string[] | null | undefined,
	fallback: Locale = DEFAULT_LOCALE
): Locale {
	if (candidates != null) {
		for (const candidate of candidates) {
			const parsed = parseLocale(candidate);
			if (parsed != null) return parsed;
		}
	}
	return fallback;
}

/** Read the persisted locale, if any. Safe in non-browser environments. */
export function storedLocale(storage: Pick<Storage, 'getItem'> | null = null): Locale | null {
	const store = storage ?? (globalThis as { localStorage?: Pick<Storage, 'getItem'> }).localStorage;
	const candidate = store?.getItem(STORED_LOCALE_KEY);
	return parseLocale(candidate);
}

/** Persist the locale choice. Safe in non-browser environments. */
export function storeLocale(locale: Locale, storage: Pick<Storage, 'setItem'> | null = null): void {
	const store = storage ?? (globalThis as { localStorage?: Pick<Storage, 'setItem'> }).localStorage;
	store?.setItem(STORED_LOCALE_KEY, locale);
}

/** Set the document language attribute. Safe in non-browser environments. */
export function setHtmlLang(locale: Locale): void {
	const doc = (globalThis as { document?: { documentElement: { lang: string } } }).document;
	if (doc) doc.documentElement.lang = intlLocale(locale);
}
