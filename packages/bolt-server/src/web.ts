import { Effect } from 'effect';
import { FacilityFailure } from '@norbital-ai/bolt/errors';
import {
	makeRequestPage,
	publicAddresses,
	WebRead,
	WEB_PAGE_BYTE_LIMIT,
	type PortFailure,
	type Address
} from '@norbital-ai/bolt/engine';
import { extractDocumentText } from './documents.ts';
const requestPage = makeRequestPage();
export type PublicPage = {
	url: string;
	body: string;
	contentType?: string;
	sha256?: string;
	pageCount?: number;
};
const failure = (message: string) => new FacilityFailure({ kind: 'upstream', message });
export const readPublicPage = Effect.fn('server.readPublicPage')(
	function* (
		url: string,
		options: {
			readonly resolve?: (hostname: string) => Promise<readonly Address[]>;
			readonly request?: typeof requestPage;
		} = {}
	) {
		if (url === '') return yield* Effect.fail(failure('A public page needs a URL.'));
		let target = yield* Effect.try({
			try: () => new URL(url),
			catch: () => failure('A public page needs a valid URL.')
		});
		for (let redirects = 0; redirects <= 5; redirects++) {
			const addresses = yield* publicAddresses(target, options.resolve);
			const response = yield* (options.request ?? requestPage)(target, addresses);
			if (response.status >= 300 && response.status < 400 && response.location) {
				const location = response.location;
				target = yield* Effect.try({
					try: () => new URL(location, target),
					catch: () => failure('The public page returned an invalid redirect URL.')
				});
				continue;
			}
			if (response.status < 200 || response.status >= 300)
				return yield* Effect.fail(failure(`Public page returned HTTP ${response.status}.`));
			const bytes =
				typeof response.body === 'string' ? new TextEncoder().encode(response.body) : response.body;
			if (bytes.byteLength > WEB_PAGE_BYTE_LIMIT)
				return yield* Effect.fail(failure('Public page exceeds the 2 MiB limit.'));
			return {
				url: target.toString(),
				contentType: response.contentType,
				...(yield* extractDocumentText(bytes, response.contentType))
			};
		}
		return yield* Effect.fail(failure('Public page exceeded five redirects.'));
	},
	(effect) =>
		effect.pipe(
			Effect.timeoutOrElse({
				duration: '30 seconds',
				orElse: () =>
					Effect.fail(
						new FacilityFailure({
							kind: 'timeout',
							message: 'The public page exceeded thirty seconds.'
						})
					)
			})
		)
);

const linksOf = (html: string, base: string): string[] =>
	[
		...new Set(
			[...html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)].flatMap((match) => {
				const href = match[1];
				if (href === undefined) return [];
				const url = URL.parse(href.trim(), base);
				if (url === null || !/^https?:$/.test(url.protocol)) return [];
				url.hash = '';
				return url.href === URL.parse(base)?.href.replace(/#.*$/, '') ? [] : [url.href];
			})
		)
	].slice(0, 1_000);

export const publicWeb = (
	read: (url: string) => Effect.Effect<PublicPage, PortFailure> = readPublicPage
): WebRead['Service'] => ({
	read: (url, options = {}) =>
		read(url).pipe(
			Effect.map((page) => {
				const title = /<title[^>]*>([^<]*)<\/title>/i.exec(page.body)?.[1]?.trim() ?? null;
				const text = page.body
					.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
					.replace(/<[^>]+>/g, ' ')
					.replace(/\s+/g, ' ')
					.trim()
					.slice(0, 200_000);
				const html =
					options.raw === true && /html|xml/i.test(page.contentType ?? 'text/html')
						? page.body
						: undefined;
				return {
					url: page.url,
					title,
					text,
					...(page.contentType === undefined ? {} : { contentType: page.contentType }),
					...(page.sha256 === undefined ? {} : { sha256: page.sha256 }),
					...(page.pageCount === undefined ? {} : { pages: page.pageCount }),
					...(html === undefined ? {} : { html, links: linksOf(html, page.url) })
				};
			})
		)
});
