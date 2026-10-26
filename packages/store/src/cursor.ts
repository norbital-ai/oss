import { Encoding, Result, Schema } from 'effect';

declare const cursor: unique symbol;
/** An opaque page cursor: pass a page's `next` back as `after` to read on. */
export type Cursor = string & { readonly [cursor]: true };

/** The engine's unpadded base64url cursor and its UTF-8 JSON payload. */
export const CursorPayload = Schema.String.check(
	Schema.makeFilter(
		(value: string) => {
			const decoded = Encoding.decodeBase64UrlString(value);
			return Result.isSuccess(decoded) && Encoding.encodeBase64Url(decoded.success) === value;
		},
		{ message: 'expected a canonical UTF-8 base64url cursor' }
	)
).pipe(
	Schema.decodeTo(Schema.StringFromBase64Url),
	Schema.decodeTo(
		Schema.fromJsonString(
			Schema.Struct({ h: Schema.String, k: Schema.Array(Schema.NullOr(Schema.String)) })
		)
	)
);

const decodePayload = Schema.decodeUnknownResult(CursorPayload);

/** A page's opaque cursor, validated without requiring its query's private hash or key count. */
export const CursorValue = Schema.String.pipe(
	Schema.decodeTo(
		Schema.declare<Cursor>((value): value is Cursor => Result.isSuccess(decodePayload(value)), {
			title: 'Cursor'
		})
	)
);
