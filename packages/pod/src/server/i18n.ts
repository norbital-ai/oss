import { serverI18n, type ServerI18n } from '$lib/i18n/index.js';
import { getRequestEvent } from '$lib/server/request-context.js';

/**
 * The translation runtime for the current request, resolved from the request's
 * own language signal.
 *
 * `?lang=` wins (a tenant can deep-link a locale), then `Accept-Language`.
 * Only usable inside request handling, where `getRequestEvent` is live —
 * the host control plane and background jobs must pass their own signal.
 */
export function requestI18n(): ServerI18n {
	const event = getRequestEvent();
	const url = new URL(event.request.url);
	const lang = url.searchParams.get('lang');
	const acceptLanguage = event.request.headers.get('accept-language');
	return serverI18n(lang ? [lang, acceptLanguage ?? ''] : acceptLanguage);
}
