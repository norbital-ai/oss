// The public page reader behind `BOLT_WEB_PROVIDER=public` (`ctx.web.read`): HTTPS only, pinned DNS, no private
// networks, checked redirects, bounded bodies; PDF and Office documents are read as text by `documents.ts`.
import { makeRequestPage, publicAddresses, WEB_PAGE_BYTE_LIMIT, type Address } from '@norbital-ai/bolt/engine';
import { extractDocumentText } from './documents.ts';

const requestPage = makeRequestPage();

/** A page as read: the final URL, its text (a document's extracted text) and, for a document, its digest and pages. */
export type PublicPage = { url: string; body: string; contentType?: string; sha256?: string; pageCount?: number };

/** Reads one public HTTPS page, following at most five redirects, each destination checked before its socket opens. */
export async function readPublicPage(
	url: string,
	signal: AbortSignal,
	options: {
		readonly resolve?: (hostname: string) => Promise<readonly Address[]>;
		readonly request?: typeof requestPage;
	} = {}
): Promise<PublicPage> {
	if (url === '') throw new Error('A public page needs a URL.');
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
	let target = new URL(url);
	for (let redirects = 0; redirects <= 5; redirects++) {
		bounded.throwIfAborted();
		const addresses = await publicAddresses(target, options.resolve); // each redirect's hostname is checked in turn
		bounded.throwIfAborted();
		const response = await (options.request ?? requestPage)(target, addresses, bounded);
		if (response.status >= 300 && response.status < 400 && response.location) {
			target = new URL(response.location, target);
			continue;
		}
		if (response.status < 200 || response.status >= 300) throw new Error(`Public page returned HTTP ${response.status}.`);
		const bytes = typeof response.body === 'string' ? new TextEncoder().encode(response.body) : response.body;
		if (bytes.byteLength > WEB_PAGE_BYTE_LIMIT) throw new Error('Public page exceeds the 2 MiB limit.');
		const document = await extractDocumentText(bytes, response.contentType, bounded);
		return { url: target.toString(), contentType: response.contentType, ...document };
	}
	throw new Error('Public page exceeded five redirects.');
}
