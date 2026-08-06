import { createI18n, pickLocale, type KeysOf } from '@norbital-ai/std/i18n';
import type { UiKeys } from '@norbital-ai/ui/i18n';
import { podMessages } from './messages.js';

export { podMessages } from './messages.js';

export type PodKeys = KeysOf<typeof podMessages>;

/**
 * The key union the pod shell and platform chrome translate with: pod chrome
 * keys plus the `@norbital-ai/ui` keys, which the build-time catalog merge
 * guarantees are present in the runtime catalog.
 */
export type PodUiKeys = PodKeys | UiKeys;

/**
 * A translation runtime over the pod chrome catalog, for server code
 * (identity pages, transactional email) that has no Svelte context.
 *
 * Resolve the locale per request with `pickLocale(acceptLanguageHeader)` or
 * `parseLocale`, then call `serverI18n(locale)`.
 */
export function serverI18n(locale?: string | readonly string[] | null) {
	const candidates = Array.isArray(locale) ? locale : locale == null ? null : [locale];
	return createI18n(podMessages, pickLocale(candidates));
}

export type ServerI18n = ReturnType<typeof serverI18n>;
