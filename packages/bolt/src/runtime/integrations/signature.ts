import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookSignatureSpec } from '../../authoring/contracts-schema.js';
import { WEBHOOK_DEFAULT_TOLERANCE_SECONDS } from '../../authoring/workspace-schema.js';

/**
 * Whether a pushed delivery really came from the source, decided before anything reads its body.
 *
 * This module is the whole of the platform's trust in an inbound delivery, so it is deliberately
 * one pure function over bytes: no database, no Effect, no facilities. Everything it needs — the
 * declared scheme, the resolved secret, the raw body, the headers, and the current time — is passed
 * in, which is what makes every branch of it directly testable, including the ones that are supposed
 * to refuse.
 *
 * Three properties are load-bearing, and each one is a way this has gone wrong elsewhere.
 *
 * **The digest is compared in constant time.** `timingSafeEqual`, never `===` and never `!==`, on
 * the decoded bytes. A byte-at-a-time comparison leaks where the first difference is, and a signature
 * is exactly the kind of value an attacker can submit a few million guesses at: with an early-exit
 * compare, the time to reject tells them how much of their guess was right, and a digest can be
 * recovered one byte at a time instead of being brute-forced whole. The difference is not
 * theoretical — it is the gap between 2^256 work and 32 × 256 work. No test can observe this
 * reliably, so `signature.test.ts` asserts it structurally: it reads this file and fails if a
 * comparison operator is applied to a digest.
 *
 * **The digest is taken over the raw body.** `body` is the bytes as they arrived, not a
 * re-serialisation of parsed JSON. `JSON.stringify(JSON.parse(x))` is not `x` — key order,
 * whitespace, unicode escaping and number formatting all move — so a digest over a reparsed body
 * matches nothing the sender computed, and the only way to make such a scheme "work" is to stop
 * checking. The caller has to keep the raw text, which is why `Integrations.receive` takes a string.
 *
 * **A correctly signed delivery is not automatically a fresh one.** A body and its signature stay
 * valid together forever; anyone who captures one can send it again. Where the source signs a
 * timestamp, a delivery outside the window is refused. Where it does not, that is stated as an
 * absence rather than hidden — see `verifyDelivery`'s return.
 */

export type SignatureRefusal = Readonly<{ readonly reason: string }>;

export type SignatureProof = Readonly<{
	/** The verified digest, hex-encoded. Used as a delivery key when the source names no event id. */
	readonly digest: string;
	/**
	 * Whether the signature covered a timestamp that was then checked against the window.
	 *
	 * `false` means this delivery is authentic but its age is unknown: the source signs no timestamp,
	 * so a captured body can be replayed at any time and this module cannot tell. That is not silently
	 * fine, and it is not silently fatal either — the identity upsert still makes a replay land on the
	 * row it already wrote rather than on a new one, which is why a source like GitHub or Shopify is
	 * usable at all. It travels in the return so the caller can record which of the two guarantees a
	 * given delivery actually had.
	 */
	readonly replayChecked: boolean;
}>;

export type SignatureOutcome =
	| Readonly<{ readonly verified: true; readonly proof: SignatureProof }>
	| Readonly<{ readonly verified: false; readonly refusal: SignatureRefusal }>;

const refuse = (reason: string): SignatureOutcome => ({ verified: false, refusal: { reason } });

/**
 * Reads a header case-insensitively.
 *
 * HTTP header names are case-insensitive and every hop is free to change their case; a source that
 * sends `X-Hub-Signature-256` through a proxy that lowercases it must not stop being verifiable.
 * Looking one up by exact match is how a verifier ends up reporting "no signature" for a delivery
 * that carried one.
 */
const headerValue = (headers: Readonly<Record<string, string>>, name: string): string | undefined => {
	const wanted = name.trim().toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.trim().toLowerCase() === wanted) return value;
	}
	return undefined;
};

/** Reads `v1` out of a `t=1699999999,v1=abc,v0=def` header — Stripe's shape. */
const parameterValue = (header: string, name: string): string | undefined => {
	for (const part of header.split(',')) {
		const separator = part.indexOf('=');
		if (separator < 0) continue;
		if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
	}
	return undefined;
};

/**
 * Decodes a presented signature into bytes, refusing anything that is not exactly that encoding.
 *
 * Strict, because Node's decoders are not: `Buffer.from('zz!!', 'hex')` answers an empty buffer and
 * `Buffer.from(x, 'base64')` silently discards characters outside the alphabet. Either would turn a
 * malformed signature into a short buffer that then fails a length check — which happens to be the
 * right answer, but by accident. Re-encoding and comparing is how this stays an answer on purpose.
 */
const decodeSignature = (value: string, encoding: 'hex' | 'base64'): Uint8Array | undefined => {
	const trimmed = value.trim();
	if (trimmed === '') return undefined;
	if (encoding === 'hex') {
		if (!/^[0-9a-fA-F]+$/u.test(trimmed) || trimmed.length % 2 !== 0) return undefined;
		return Uint8Array.from(Buffer.from(trimmed, 'hex'));
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(trimmed)) return undefined;
	const decoded = Buffer.from(trimmed, 'base64');
	return decoded.toString('base64').replace(/=+$/u, '') === trimmed.replace(/=+$/u, '')
		? Uint8Array.from(decoded)
		: undefined;
};

/** Seconds since the epoch, from the two forms sources actually send. */
const timestampMs = (value: string): number | undefined => {
	const trimmed = value.trim();
	if (trimmed === '') return undefined;
	if (/^\d+$/u.test(trimmed)) {
		const seconds = Number(trimmed);
		return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
	}
	const parsed = Date.parse(trimmed);
	return Number.isNaN(parsed) ? undefined : parsed;
};

export type Delivery = Readonly<{
	readonly headers: Readonly<Record<string, string>>;
	/** The request body exactly as it arrived. Never a re-serialisation of the parsed document. */
	readonly body: string;
}>;

/**
 * Verifies one delivery against one declared scheme.
 *
 * Order matters and is deliberate. The signature is checked first and the freshness window second,
 * because the timestamp is only worth reading once it is known to be authentic: it is part of the
 * signed payload, so before the digest matches it is a value the sender — whoever that is — chose.
 * Checking freshness first would mean refusing or accepting on the strength of an unauthenticated
 * number.
 *
 * Every refusal returns a reason rather than throwing, because refusing is a normal outcome here
 * rather than an exceptional one, and the caller records it.
 */
export const verifyDelivery = (
	signature: WebhookSignatureSpec,
	secret: string,
	delivery: Delivery,
	nowMs: number
): SignatureOutcome => {
	// A secret the vault answered with but which is empty verifies everything against an empty key.
	// That is worse than having no secret at all, because the route looks configured.
	if (secret === '') {
		return refuse(`the vault holds no value for ${signature.secret.env}, and verifying against an empty secret would accept a digest anybody can compute`);
	}
	const header = headerValue(delivery.headers, signature.header);
	if (header === undefined || header.trim() === '') {
		return refuse(`the delivery carries no ${signature.header} header, so nothing about it is signed`);
	}
	const presented = signature.parameter === undefined ? header : parameterValue(header, signature.parameter);
	if (presented === undefined) {
		return refuse(`the ${signature.header} header carries no ${signature.parameter} parameter`);
	}
	const prefix = signature.prefix ?? '';
	if (prefix !== '' && !presented.startsWith(prefix)) {
		return refuse(`the ${signature.header} header does not start with the declared ${prefix} prefix`);
	}
	const encoding = signature.encoding ?? 'hex';
	const provided = decodeSignature(presented.slice(prefix.length), encoding);
	if (provided === undefined) {
		return refuse(`the ${signature.header} header is not readable as ${encoding}`);
	}

	const stamp = signature.timestamp === undefined
		? undefined
		: 'header' in signature.timestamp
			? headerValue(delivery.headers, signature.timestamp.header)
			: parameterValue(header, signature.timestamp.parameter);
	if (signature.timestamp !== undefined && (stamp === undefined || stamp.trim() === '')) {
		return refuse('the delivery carries no signed timestamp, so its age cannot be checked and a captured body could be replayed');
	}

	const algorithm = signature.algorithm ?? 'sha256';
	const signedPayload = (signature.signedPayload ?? '{body}')
		.replaceAll('{timestamp}', stamp ?? '')
		.replaceAll('{body}', delivery.body);
	const expected = Uint8Array.from(createHmac(algorithm, secret).update(signedPayload, 'utf8').digest());

	// Length first, because `timingSafeEqual` throws on operands of different lengths. This leaks
	// nothing: a digest's length is fixed by its algorithm and is therefore already public.
	if (provided.length !== expected.length) {
		return refuse(`the ${signature.header} signature is ${provided.length} bytes where ${algorithm} produces ${expected.length}`);
	}
	// Constant time, on purpose. See this module's header: an early-exit comparison turns recovering a
	// digest from a brute-force search into a byte-at-a-time one.
	if (!timingSafeEqual(provided, expected)) {
		return refuse(`the ${signature.header} signature does not match the body under the declared secret`);
	}

	if (signature.timestamp === undefined || stamp === undefined) {
		return { verified: true, proof: { digest: Buffer.from(expected).toString('hex'), replayChecked: false } };
	}
	const sentMs = timestampMs(stamp);
	if (sentMs === undefined) {
		return refuse(`the signed timestamp "${stamp}" is neither epoch seconds nor a parseable date`);
	}
	const toleranceMs = (signature.toleranceSeconds ?? WEBHOOK_DEFAULT_TOLERANCE_SECONDS) * 1000;
	// Absolute, so a delivery stamped in the future is refused too. A clock that far ahead is either
	// skewed past the point the window was chosen to absorb, or an attacker buying themselves a
	// replay window that outlives the one the source intended.
	const ageMs = Math.abs(nowMs - sentMs);
	if (ageMs > toleranceMs) {
		return refuse(`the delivery is signed for ${new Date(sentMs).toISOString()}, ${Math.round(ageMs / 1000)}s from now, outside the ${toleranceMs / 1000}s replay window`);
	}
	return { verified: true, proof: { digest: Buffer.from(expected).toString('hex'), replayChecked: true } };
};
