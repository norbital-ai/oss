import { Effect, Result } from 'effect';
import type { WebhookSignatureSpec } from '#lib/authoring/contracts-schema.js';
import { WEBHOOK_DEFAULT_TOLERANCE_SECONDS } from '#lib/authoring/workspace-schema.js';

/**
 * Whether a pushed delivery really came from the source, decided before anything reads its body.
 *
 * This module is the whole of the platform's trust in an inbound delivery, so it is deliberately
 * one operation over bytes: no database and no facilities. Everything it needs — the declared
 * scheme, the resolved secret, the raw body, the headers, and the current time — is passed in. Its
 * Effect exists only because browser WebCrypto is asynchronous, which keeps every branch directly
 * testable, including the ones that are supposed to refuse.
 *
 * Three properties are load-bearing, and each one is a way this has gone wrong elsewhere.
 *
 * **The digest is compared in constant time.** WebCrypto's native HMAC verification checks the
 * presented bytes, never `===` and never `!==` in JavaScript. A byte-at-a-time early exit leaks where
 * the first difference is, and a signature is exactly the kind of value an attacker can submit a
 * few million guesses at: the time to reject tells them how much of their guess was right.
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

type SignatureRefusal = Readonly<{ readonly reason: string }>;

type SignatureProof = Readonly<{
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

type SignatureOutcome =
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
const headerValue = (
	headers: Readonly<Record<string, string>>,
	name: string
): string | undefined => {
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
		const decoded = new Uint8Array(trimmed.length / 2);
		for (let index = 0; index < decoded.length; index += 1) {
			decoded[index] = Number.parseInt(trimmed.slice(index * 2, index * 2 + 2), 16);
		}
		return decoded;
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(trimmed)) return undefined;
	// `atob` refuses a length no base64 string can have, and that refusal is one of the answers this
	// function exists to give rather than an exception to swallow — so it goes through Effect's error
	// channel and comes back as a `Result` this reads like any other branch.
	const decoded = Effect.runSync(
		Effect.result(
			Effect.try(() => Uint8Array.from(atob(trimmed), (character) => character.charCodeAt(0)))
		)
	);
	if (Result.isFailure(decoded)) return undefined;
	let binary = '';
	for (const byte of decoded.success) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/=+$/u, '') === trimmed.replace(/=+$/u, '')
		? decoded.success
		: undefined;
};

/** HMAC digest and native verification through the API shared by browsers, Node and sandboxes. */
const hmacProof = Effect.fn('Integrations.hmacProof')(function* (
	algorithm: 'sha256' | 'sha512',
	secret: string,
	payload: string,
	provided: Uint8Array
) {
	const hash = algorithm === 'sha512' ? 'SHA-512' : 'SHA-256';
	const encoder = new TextEncoder();
	const payloadBytes = encoder.encode(payload);
	const key = yield* Effect.promise(() =>
		globalThis.crypto.subtle.importKey(
			'raw',
			encoder.encode(secret),
			{ name: 'HMAC', hash },
			false,
			['sign', 'verify']
		)
	);
	const digest = yield* Effect.promise(() =>
		globalThis.crypto.subtle.sign('HMAC', key, payloadBytes)
	);
	// Copy onto a concrete ArrayBuffer. A caller's Uint8Array may legally be backed by a
	// SharedArrayBuffer, while WebCrypto accepts only BufferSource over ArrayBuffer.
	const signatureBytes = new Uint8Array(provided.length);
	signatureBytes.set(provided);
	const matches = yield* Effect.promise(() =>
		globalThis.crypto.subtle.verify('HMAC', key, signatureBytes, payloadBytes)
	);
	return { expected: new Uint8Array(digest), matches };
});

/** Lowercase hexadecimal, used for the verified digest's stable delivery key. */
const hex = (bytes: Uint8Array): string =>
	[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

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

type Delivery = Readonly<{
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
export const verifyDelivery = Effect.fn('Integrations.verifyDelivery')(function* (
	signature: WebhookSignatureSpec,
	secret: string,
	delivery: Delivery,
	nowMs: number
) {
	// A secret the vault answered with but which is empty verifies everything against an empty key.
	// That is worse than having no secret at all, because the route looks configured.
	if (secret === '') {
		return refuse(
			`the vault holds no value for ${signature.secret.env}, and verifying against an empty secret would accept a digest anybody can compute`
		);
	}
	const header = headerValue(delivery.headers, signature.header);
	if (header === undefined || header.trim() === '') {
		return refuse(
			`the delivery carries no ${signature.header} header, so nothing about it is signed`
		);
	}
	const presented =
		signature.parameter === undefined ? header : parameterValue(header, signature.parameter);
	if (presented === undefined) {
		return refuse(`the ${signature.header} header carries no ${signature.parameter} parameter`);
	}
	const prefix = signature.prefix ?? '';
	if (prefix !== '' && !presented.startsWith(prefix)) {
		return refuse(
			`the ${signature.header} header does not start with the declared ${prefix} prefix`
		);
	}
	const encoding = signature.encoding ?? 'hex';
	const provided = decodeSignature(presented.slice(prefix.length), encoding);
	if (provided === undefined) {
		return refuse(`the ${signature.header} header is not readable as ${encoding}`);
	}

	const stamp =
		signature.timestamp === undefined
			? undefined
			: 'header' in signature.timestamp
				? headerValue(delivery.headers, signature.timestamp.header)
				: parameterValue(header, signature.timestamp.parameter);
	if (signature.timestamp !== undefined && (stamp === undefined || stamp.trim() === '')) {
		return refuse(
			'the delivery carries no signed timestamp, so its age cannot be checked and a captured body could be replayed'
		);
	}

	const algorithm = signature.algorithm ?? 'sha256';
	const signedPayload = (signature.signedPayload ?? '{body}')
		.replaceAll('{timestamp}', stamp ?? '')
		.replaceAll('{body}', delivery.body);
	const proof = yield* hmacProof(algorithm, secret, signedPayload, provided);
	const expected = proof.expected;

	// Length first. This leaks nothing: a digest's length is fixed by its algorithm and is therefore
	// already public.
	if (provided.length !== expected.length) {
		return refuse(
			`the ${signature.header} signature is ${provided.length} bytes where ${algorithm} produces ${expected.length}`
		);
	}
	// Native HMAC verification, on purpose. See this module's header: a JavaScript early-exit
	// comparison turns recovering a digest from a brute-force search into a byte-at-a-time one.
	if (!proof.matches) {
		return refuse(
			`the ${signature.header} signature does not match the body under the declared secret`
		);
	}

	if (signature.timestamp === undefined || stamp === undefined) {
		return {
			verified: true,
			proof: { digest: hex(expected), replayChecked: false }
		} satisfies SignatureOutcome;
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
		return refuse(
			`the delivery is signed for ${new Date(sentMs).toISOString()}, ${Math.round(ageMs / 1000)}s from now, outside the ${toleranceMs / 1000}s replay window`
		);
	}
	return {
		verified: true,
		proof: { digest: hex(expected), replayChecked: true }
	} satisfies SignatureOutcome;
});
