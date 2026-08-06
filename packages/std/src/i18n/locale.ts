/**
 * Locale identifiers, BCP-47 parsing, and document/storage helpers for
 * Norbital's supported languages.
 *
 * The set of supported locales is deliberately closed. Adding a language is a
 * product decision that touches every catalog in the system, so it is a
 * one-line change in this module plus new catalogs — never an open string.
 */

/** The supported application locales. English is the source-of-truth catalog. */
export type Locale = 'en' | 'zh';

export const LOCALES: readonly Locale[] = ['en', 'zh'] as const;

export const DEFAULT_LOCALE: Locale = 'en';

/** The Intl locale each application locale maps to for `Intl.*` formatting. */
export const INTL_LOCALE: Record<Locale, string> = {
	en: 'en-US',
	zh: 'zh-CN'
};

/** Browser/localStorage key under which a viewer's locale choice is persisted. */
export const STORED_LOCALE_KEY = 'norbital.locale';

export function isLocale(value: unknown): value is Locale {
	return value === 'en' || value === 'zh';
}

/**
 * Parse a BCP-47 tag into a supported application locale, or null.
 *
 * `zh-CN`, `zh-TW`, and `zh-Hans` all resolve to `zh`; anything whose primary
 * subtag is not `en` or `zh` resolves to null. Malformed values resolve to
 * null — never to a guessed locale, so callers keep their fallback chain.
 */
export function parseLocale(value: string | null | undefined): Locale | null {
	if (value == null) return null;
	const primary = value.trim().split(/[-_]/)[0]?.toLowerCase();
	return primary === 'en' || primary === 'zh' ? primary : null;
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
	if (doc) doc.documentElement.lang = INTL_LOCALE[locale];
}
