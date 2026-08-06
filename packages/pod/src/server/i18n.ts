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

/**
 * The request's locale when one is live, English otherwise.
 *
 * Deep collection, approval and file layers run both inside request handling (sync mutations,
 * remote commands) and outside it (background jobs, host commands, control-plane dispatch).
 * These layers resolve the request locale when one exists so the prose they raise reaches the
 * caller in their language; outside a request the fallback yields English, which is exactly
 * where an infra failure that only gets logged should stay.
 */
export function requestI18nOrDefault(): ServerI18n {
	try {
		return requestI18n();
	} catch {
		return serverI18n(null);
	}
}
