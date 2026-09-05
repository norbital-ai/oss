import { Schema } from 'effect';

/** Public-page retrieval is read-only and carries the final URL after redirects. */
export const WebPage = Schema.Struct({
	url: Schema.NonEmptyString,
	contentType: Schema.String,
	body: Schema.String,
	/** Digest of the retrieved bytes, before PDF/text decoding. */
	sha256: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
	pageCount: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)))
});
export type WebPage = typeof WebPage.Type;
export const WebPageRequest = Schema.Struct({ url: Schema.NonEmptyString });
export const WEB_READ_OPERATION = 'web.read';
export const WEB_PAGE_BYTE_LIMIT = 2 * 1024 * 1024;
