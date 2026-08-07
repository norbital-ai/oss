import { getContext, setContext } from 'svelte';
import {
	type Locale,
	type LocaleCatalogs,
	type KeysOf,
	type MessageVars,
	INTL_LOCALE,
	pickLocale,
	storedLocale,
	storeLocale,
	setHtmlLang,
	translate
} from '@norbital-ai/std/i18n';
import { uiMessages, type UiKeys } from './messages/index.js';

/** The translation API a component consumes. `Keys` is the catalog key union. */
export interface I18nApi<Keys extends string = string> {
	/** The active application locale. */
	readonly locale: Locale;
	/** The `Intl.*` locale string for the active locale (`en-US` / `zh-CN`). */
	readonly intlLocale: string;
	/** Translate a typed key, with `{placeholder}` interpolation. */
	readonly t: (key: Keys, vars?: MessageVars) => string;
	/** True when the key exists in either locale of the catalog pair. */
	has(key: string): boolean;
	/** Switch the active locale; persists the choice and sets `<html lang>`. */
	setLocale(locale: Locale): void;
}

/**
 * Reactive translation state, provided once at an application root.
 *
 * `locale` is `$state`, and `t`/`intlLocale` read it on every call, so a
 * component that destructures `const { t } = useI18n()` still re-renders when
 * the locale changes.
 */
class I18nState<C extends LocaleCatalogs> {
	readonly #catalogs: C;
	locale = $state<Locale>('en');

	constructor(catalogs: C, initialLocale: Locale) {
		this.#catalogs = catalogs;
		this.locale = initialLocale;
	}

	t = (key: KeysOf<C>, vars?: MessageVars): string =>
		translate(this.#catalogs, this.locale, key, vars);

	has = (key: string): boolean => key in this.#catalogs.en || key in this.#catalogs.zh;

	setLocale(next: Locale): void {
		if (next === this.locale) return;
		this.locale = next;
		storeLocale(next);
		setHtmlLang(next);
	}

	get intlLocale(): string {
		return INTL_LOCALE[this.locale];
	}
}

/**
 * Private context key for the ui's translation state.
 *
 * Deliberately NOT `createContext()` from svelte: since 5.40 its `use` throws
 * `missing_context` when no provider is installed, which would make the global
 * fallback in `useI18n` unreachable for apps that never install the ui provider
 * (the website and the Core shell provide their own catalogs, not this one).
 * `getContext` returns `undefined` instead, so the fallback stays live.
 */
const I18N_CONTEXT_KEY = Symbol('@norbital-ai/ui/i18n');

function useI18nContext(): (() => I18nState<LocaleCatalogs> | null) | undefined {
	return getContext(I18N_CONTEXT_KEY);
}

/**
 * Install the application's catalog pair and initial locale for the whole
 * component subtree. Call once from an application root (pod shell, core
 * layout, website layout) during component init.
 *
 * The initial locale resolves as: persisted choice, browser languages, then
 * English.
 */
export function provideI18n<C extends LocaleCatalogs>(
	catalogs: C,
	initialLocale?: Locale
): I18nApi<KeysOf<C>> {
	const browserLanguages = (globalThis as { navigator?: { languages?: readonly string[] } })
		.navigator?.languages;
	const state = new I18nState(
		catalogs,
		initialLocale ?? storedLocale() ?? pickLocale(browserLanguages)
	);
	setContext(I18N_CONTEXT_KEY, () => state);
	return state;
}

/**
 * Read the translation API from context.
 *
 * Falls back to the ui package's own catalog and a module-level global locale
 * (see `setGlobalLocale`) when no provider is installed — which keeps
 * components renderable in isolation and lets apps without the context
 * mechanism still switch the shared ui chrome.
 */
export function useI18n<Keys extends string = string>(): I18nApi<Keys> {
	const state = useI18nContext()?.() ?? ensureGlobalState();
	return state as I18nApi<Keys>;
}

// ---------------------------------------------------------------------------
// Fallback path: no provider installed.
// ---------------------------------------------------------------------------

let globalI18nState: I18nState<typeof uiMessages> | undefined;

function ensureGlobalState(): I18nState<typeof uiMessages> {
	if (!globalI18nState) {
		globalI18nState = new I18nState(uiMessages, 'en');
	}
	return globalI18nState;
}

/**
 * Switch the ui package's fallback locale for apps that do not install a
 * provider (only possible once `@norbital-ai/ui` ships the i18n module).
 */
export function setGlobalLocale(locale: Locale): void {
	ensureGlobalState().setLocale(locale);
}

export function getGlobalLocale(): Locale {
	return ensureGlobalState().locale;
}

export type { UiKeys };
