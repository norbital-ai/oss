import { Effect } from 'effect';
import { FacilityFailure, type PortFailure, type WebPage } from '@norbital-ai/host-api';
import { read_public_page } from '@norbital-ai/host-api/node';
import { extractDocumentText } from './documents.ts';
export type PublicPage = {
	url: string;
	body: string;
	contentType?: string;
	sha256?: string;
	pageCount?: number;
};
export const readPublicPage: (
	url: string,
	options?: Parameters<typeof read_public_page>[1]
) => Effect.Effect<PublicPage, PortFailure> = Effect.fn('server.readPublicPage')(
	function* (url: string, options: Parameters<typeof read_public_page>[1] = {}) {
		const page = yield* read_public_page(url, options);
		return {
			url: page.url,
			contentType: page.contentType,
			...(yield* extractDocumentText(page.bytes, page.contentType))
		};
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

/** A public-page reader as Effects (`WebReadPort` without its signal); `raw` also answers the markup and its links. */
export type WebReader = {
	readonly read: (
		url: string,
		options?: { readonly raw?: boolean }
	) => Effect.Effect<WebPage, PortFailure>;
};
export const publicWeb = (
	read: (url: string) => Effect.Effect<PublicPage, PortFailure> = readPublicPage
): WebReader => ({
	read: (url, options = {}) =>
		read(url).pipe(
			Effect.map((page) => {
				const title = /<title[^>]*>([^<]*)<\/title>/i.exec(page.body)?.[1]?.trim() ?? null;
				const text = page.body
					.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
					.replace(/<[^>]+>/g, ' ')
					.replace(/\s+/g, ' ')
					.trim()
					// a whole statute's text (an Act runs past 300,000 characters) fits in one guest crossing; a quote in its
					// last part must still be found
					.slice(0, 1_000_000);
				const html =
					options.raw === true && /html|xml/i.test(page.contentType ?? 'text/html')
						? page.body
						: undefined;
				return {
					url: page.url,
					title,
					text,
					...(page.contentType === undefined ? {} : { content_type: page.contentType }),
					...(page.sha256 === undefined ? {} : { sha256: page.sha256 }),
					...(page.pageCount === undefined ? {} : { pages: page.pageCount }),
					...(html === undefined ? {} : { html, links: linksOf(html, page.url) })
				};
			})
		)
});
