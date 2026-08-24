import { Config, Context, Effect, Layer, Option, Redacted, Schema } from 'effect';

/**
 * The one place a stored secret is turned into ciphertext, and the only place it is turned back.
 *
 * It lives in `std` rather than in any one application because more than one thing now has a secret
 * to store, and they are not in the same trust domain. Bolt's two vaults — `Secrets` (`bolt_secrets`,
 * workspace configuration, the values behind every `{ env: 'NAME' }` credential an integration or
 * channel declares) and `PersonalSecrets` (`bolt_personal_secrets`, a named person's own signed-in
 * session) — hold values tenant code legitimately needs. Colony's browser session store holds cookies
 * that tenant code must *never* reach, and so keeps them host-side in Colony's own control database.
 * Different homes, different readers, one envelope: two implementations would be two chances to get
 * the refusal below wrong, and the refusal is the whole point. A store that quietly writes plaintext
 * when it cannot encrypt is worse than one that never claimed to encrypt, because the call site
 * cannot tell the difference.
 *
 * This module depends on WebCrypto and `effect`, and on nothing else — that is what makes it
 * shareable, and WebCrypto rather than `node:crypto` is what makes it shareable with the *tenant
 * runtime*, where `node:` builtins are externalized stubs whose every member is `undefined`. Nothing here knows which table a row lives in; a caller says so through
 * its binding.
 *
 * **AES-256-GCM, through WebCrypto.** GCM authenticates as well as conceals. A tampered
 * ciphertext must fail loudly rather than decrypt to plausible garbage that a caller then sends to
 * LinkedIn as a cookie — with an unauthenticated mode a flipped byte in the database produces a
 * different string and nothing anywhere notices.
 *
 * **The key is host-held and never in the database it protects.** It is read from configuration
 * (`BOLT_SECRETS_KEY`) through Effect's `ConfigProvider`, which is how a host supplies it and how a
 * test overrides it, and it is carried as `Redacted` so a log line, a span attribute or an accidental
 * `JSON.stringify` of a service prints `<redacted>` instead of the key. A key stored beside its own
 * ciphertext protects against nothing at all: whoever can read the row can read the key.
 *
 * **Fail closed, with no plaintext branch anywhere in the module.** `encrypt` has exactly one exit
 * that returns a string, and reaching it requires a usable key. Every other route — key absent, key
 * the wrong length, key not decodable, configuration source unreadable — is `SecretKeyUnavailable`.
 * That is deliberately the same answer for "not configured" and "misconfigured": both mean the value
 * cannot be protected, and only the `reason` differs so an operator can tell which one they have.
 *
 * ## The stored encoding, and why
 *
 * `v1.<nonce>.<ciphertext>.<tag>`, each part base64url, in an ordinary `text` column.
 *
 * - **Versioned, in front, in the clear.** `v1.` is the only thing that makes rotation possible
 *   later: a `v2` writer can emit a new prefix while `v1` rows keep decrypting, and neither has to
 *   guess which scheme produced a given row. It is also what makes a *pre-encryption* row
 *   recognisable — a plaintext value has no envelope, so `decrypt` can say "this predates encryption"
 *   rather than reporting it as corruption.
 * - **Three parts, not one blob.** Nonce and tag are fixed-width, so a concatenated blob would decode
 *   the same way; separating them means a malformed value is rejected while parsing instead of being
 *   sliced into three wrong pieces that then fail an authentication check for a misleading reason.
 * - **base64url.** Its alphabet contains no `.`, so the separator can never appear inside a part and
 *   the split is unambiguous without escaping. It also survives every place a secret name or value
 *   currently travels as text.
 * - **Still one `text` column.** No column type change and no second column, so a vault's `status`
 *   keeps answering from `length(value) > 0` and `updated_at` without ever touching a ciphertext, and
 *   an existing `create table if not exists` stays as it is. Colony's `colony_control_store` already
 *   has a `text_value` column, so the envelope lands there unchanged and needs no migration.
 *
 * ## Binding a row to its own identity
 *
 * The envelope is authenticated *with* the row's identity as GCM's additional authenticated data —
 * `bolt_personal_secrets`, tenant, user, name for a personal row; `bolt_secrets` and name for a
 * workspace one; `colony_browser_sessions`, tenant, profile, name for a stored browser session.
 * Nothing about that identity is stored in the envelope; it is recomputed from the row being read,
 * so a mismatch surfaces as an authentication failure.
 *
 * Without it, an attacker with write access to the database — which is a strictly weaker position
 * than holding the key — could copy user A's envelope into user B's row and have B's session become
 * A's, or move a low-value credential's ciphertext onto a high-value name. Naming the *store* in the
 * binding extends that across stores as well as within one: a `bolt_personal_secrets` envelope
 * dropped into Colony's browser session table fails to open, and so does the reverse, even though
 * both are sealed under the same host key. Neither moves any plaintext, so no amount of encryption
 * alone would notice.
 *
 * The parts are length-prefixed rather than delimiter-joined because names are free-form:
 * `('a:b', 'c')` and `('a', 'b:c')` must not produce the same binding.
 */

/** The configuration key a host supplies the vault key under. Read through `ConfigProvider`, never through `process.env`. */
export const SECRET_KEY_VARIABLE = 'BOLT_SECRETS_KEY';

/** AES-256 takes a 256-bit key; nothing shorter is accepted, and nothing longer is truncated into one. */
const KEY_BYTES = 32;
/** 96 bits, the nonce width GCM is specified and optimised for. */
const NONCE_BYTES = 12;
/** The full 128-bit tag. A truncated tag is a weaker forgery bound for no saving worth having. */
const TAG_BYTES = 16;
const VERSION = 'v1';

/**
 * The refusal that keeps a secret from being stored in the clear.
 *
 * Raised by `encrypt` when there is no usable key, and by `decrypt` when a stored value cannot even
 * be attempted. It is not retryable: nothing about the request will make the host's configuration
 * appear, and a caller retrying only delays the operator finding out.
 *
 * The tags below still read `Bolt.Secrets.*` after the move into `std`. A tagged error's tag is its
 * observable identity — asserted in tests, matched by operators reading a failure — and renaming it
 * would be a behaviour change dressed up as a file move. A caller in another application that wants
 * its own vocabulary maps this into its own failure at its boundary rather than renaming it here.
 */
export class SecretKeyUnavailable extends Schema.TaggedError<SecretKeyUnavailable>()(
	'Bolt.Secrets.KeyUnavailable',
	{ operation: Schema.NonEmptyString, reason: Schema.NonEmptyString }
) {
	readonly message = `${this.operation} is refused because secrets cannot be encrypted: ${this.reason}. Set ${SECRET_KEY_VARIABLE} to 32 bytes of base64 (\`openssl rand -base64 32\`); until then a value would have to be stored in the clear, and storing it in the clear silently is worse than refusing it loudly.`;
	readonly retryable = false;
	readonly outcome = 'known' as const;
}

/**
 * A stored value that did not come back out.
 *
 * Deliberately distinct from "there is no value": a caller that hears `null` will offer to set the
 * credential up, which is right for an empty row and wrong for one that is present and unreadable.
 */
export class SecretUnreadable extends Schema.TaggedError<SecretUnreadable>()(
	'Bolt.Secrets.Unreadable',
	{ name: Schema.NonEmptyString, reason: Schema.NonEmptyString }
) {
	readonly message = `The stored value for ${this.name} could not be decrypted: ${this.reason}. It has to be set again; nothing here can recover it, and answering with the bytes as they stand would hand out a value nobody wrote.`;
	readonly retryable = false;
	readonly outcome = 'known' as const;
}

export type Interface = Readonly<{
	/** Seals a value into the `v1` envelope, or refuses. There is no third outcome and no plaintext one. */
	readonly encrypt: (
		operation: string,
		binding: string,
		value: string
	) => Effect.Effect<string, SecretKeyUnavailable>;
	/** Opens an envelope written under the same key *and* the same row identity, or says why it could not. */
	readonly decrypt: (
		name: string,
		binding: string,
		stored: string
	) => Effect.Effect<string, SecretKeyUnavailable | SecretUnreadable>;
}>;

export const Service = Context.Service<Interface>('@norbital-ai/std/SecretCipher');

/**
 * The identity a row's ciphertext is bound to, length-prefixed so no combination of parts collides.
 *
 * `'ab' + 'c'` and `'a' + 'bc'` join to the same string; `2:ab1:c` and `1:a2:bc` do not. Secret and
 * session names are free-form, so this is reachable input rather than a theoretical concern.
 *
 * Exported because the bindings themselves are not: which parts identify a row is a fact about the
 * store that owns it, so each store states its own beside its own schema rather than having this
 * module accumulate a list of every table in the system.
 */
export const bind = (...parts: ReadonlyArray<string>): string =>
	parts.map((part) => `${part.length}:${part}`).join('');

/**
 * What the host's configuration yielded, resolved once at layer construction.
 *
 * `Unavailable` carries the reason rather than being a bare absence, because "you set nothing" and
 * "you set something that is not a key" need different fixes and produce the same refusal.
 */
type KeyMaterial =
	| { readonly _tag: 'Key'; readonly key: Redacted.Redacted<Uint8Array> }
	| { readonly _tag: 'Unavailable'; readonly reason: string };

/**
 * 32 bytes of base64, and checked as such rather than coerced into it.
 *
 * `Buffer.from` drops characters it does not recognise instead of failing, so a typo'd key would
 * decode to *some* buffer — the shape is checked before the length so a mangled value is reported as
 * mangled rather than as the wrong size.
 */
/**
 * base64url, both directions, without `Buffer`.
 *
 * `node:buffer` and `node:crypto` are externalized stubs in the bundle a tenant isolate evaluates,
 * so every one of their members is `undefined` there — and `Buffer.from(...)` is therefore
 * `undefined.from(...)`, which is a `TypeError` at the first use and not a missing-module error at
 * import. That is exactly how this failed: `resolveKey` runs at layer construction, so once the host
 * began answering the vault key through the config facility the *whole runtime* stopped building,
 * and every workspace on a reset came up unmigrated with `Cannot read properties of undefined`.
 *
 * Written out rather than reached for, because there is no `Buffer` to reach for and `atob`/`btoa`
 * are base64 rather than base64url — different alphabet, and padded.
 */
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const toBase64Url = (bytes: Uint8Array): string => {
	let out = '';
	for (let index = 0; index < bytes.length; index += 3) {
		const a = bytes[index] as number;
		const b = bytes[index + 1];
		const c = bytes[index + 2];
		out += BASE64URL_ALPHABET[a >> 2];
		out += BASE64URL_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
		if (b === undefined) break;
		out += BASE64URL_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
		if (c === undefined) break;
		out += BASE64URL_ALPHABET[c & 63];
	}
	return out;
};

/**
 * Decodes base64url, or `undefined` for anything that is not.
 *
 * Strict where `Buffer.from` was lenient, which the comment on `BASE64_KEY` already wanted:
 * `Buffer.from` silently drops characters it does not recognise, so a typo'd key decoded to *some*
 * buffer of the wrong length and was reported as the wrong size rather than as mangled.
 */
const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> | undefined => {
	const trimmed = text.replace(/=+$/, '');
	const out: Array<number> = [];
	let accumulator = 0;
	let bits = 0;
	for (const character of trimmed) {
		const value = BASE64URL_ALPHABET.indexOf(character);
		if (value < 0) return undefined;
		accumulator = (accumulator << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out.push((accumulator >> bits) & 0xff);
		}
	}
	return Uint8Array.from(out);
};

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

/**
 * A view TypeScript will accept as a `BufferSource`.
 *
 * `Uint8Array` defaults to `Uint8Array<ArrayBufferLike>`, and WebCrypto's signatures want an
 * `ArrayBuffer` behind it — a distinction that is only a type, since a copy of the bytes satisfies
 * both. Copying is free at these sizes: a 32-byte key, a nonce, a tag, and a secret nobody stores
 * megabytes of.
 */
const sourced = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes);

/** The AES-GCM key handle. WebCrypto, never `node:crypto`, for the reason `toBase64Url` gives. */
const importKey = (key: Uint8Array, usage: 'encrypt' | 'decrypt'): Effect.Effect<CryptoKey> =>
	Effect.promise(() =>
		crypto.subtle.importKey('raw', sourced(key), { name: 'AES-GCM' }, false, [usage])
	);

const BASE64_KEY = /^[A-Za-z0-9+/_-]{43}=?$/;

const resolveKey = (configured: Option.Option<Redacted.Redacted<string>>): KeyMaterial => {
	if (Option.isNone(configured))
		return { _tag: 'Unavailable', reason: `${SECRET_KEY_VARIABLE} is not set` };
	const text = Redacted.value(configured.value).trim();
	if (!BASE64_KEY.test(text))
		return { _tag: 'Unavailable', reason: `${SECRET_KEY_VARIABLE} is not 32 bytes of base64` };
	const bytes = fromBase64Url(text);
	if (bytes === undefined)
		return { _tag: 'Unavailable', reason: `${SECRET_KEY_VARIABLE} is not decodable base64url` };
	if (bytes.length !== KEY_BYTES)
		return {
			_tag: 'Unavailable',
			reason: `${SECRET_KEY_VARIABLE} decodes to ${bytes.length} bytes, and AES-256 needs ${KEY_BYTES}`
		};
	return { _tag: 'Key', key: Redacted.make(bytes) };
};

/**
 * The sealed form. Every branch that could return the input unsealed is a failure instead.
 *
 * Async because WebCrypto is. The stored encoding is byte-identical to what `node:crypto` produced,
 * which is the property that matters: every value already in a vault was sealed by that
 * implementation and has to keep opening.
 *
 * WebCrypto returns the authentication tag appended to the ciphertext rather than beside it, so the
 * split back into the envelope's third and fourth parts is done here, against `TAG_BYTES`, rather
 * than read off an API that hands them over separately.
 */
const seal = (key: Uint8Array, binding: string, value: string): Effect.Effect<string> =>
	Effect.gen(function* () {
		const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
		const cipher = yield* importKey(key, 'encrypt');
		const sealed = new Uint8Array(
			yield* Effect.promise(() =>
				crypto.subtle.encrypt(
					{ name: 'AES-GCM', iv: nonce, additionalData: utf8(binding), tagLength: TAG_BYTES * 8 },
					cipher,
					utf8(value)
				)
			)
		);
		const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
		const tag = sealed.subarray(sealed.length - TAG_BYTES);
		return [VERSION, toBase64Url(nonce), toBase64Url(ciphertext), toBase64Url(tag)].join('.');
	});

type Opened =
	| { readonly _tag: 'Value'; readonly value: string }
	| { readonly _tag: 'Rejected'; readonly reason: string };

const open = (key: Uint8Array, binding: string, stored: string): Effect.Effect<Opened> => {
	const parts = stored.split('.');
	const [version, nonce, ciphertext, tag] = parts;
	if (
		parts.length !== 4 ||
		version !== VERSION ||
		nonce === undefined ||
		ciphertext === undefined ||
		tag === undefined
	)
		// The plaintext case lands here, and saying so is the point: a value with no envelope was written
		// before this vault encrypted anything, and no key will ever open it.
		return Effect.succeed({
			_tag: 'Rejected' as const,
			reason: `it is not a ${VERSION} envelope, so it was stored before this vault encrypted anything and predates the key`
		});
	const nonceBytes = fromBase64Url(nonce);
	const tagBytes = fromBase64Url(tag);
	const ciphertextBytes = fromBase64Url(ciphertext);
	if (
		nonceBytes === undefined ||
		tagBytes === undefined ||
		ciphertextBytes === undefined ||
		nonceBytes.length !== NONCE_BYTES ||
		tagBytes.length !== TAG_BYTES
	)
		return Effect.succeed({
			_tag: 'Rejected' as const,
			reason:
				'its nonce or authentication tag is the wrong size, so the stored value has been altered'
		});
	// Ciphertext and tag are handed back joined, which is how WebCrypto takes them — the envelope
	// keeps them apart so a malformed value is rejected while parsing rather than sliced into
	// pieces that then fail an authentication check for a misleading reason.
	const joined = new Uint8Array(new ArrayBuffer(ciphertextBytes.length + tagBytes.length));
	joined.set(ciphertextBytes);
	joined.set(tagBytes, ciphertextBytes.length);
	// Rejects when the tag does not verify. That is the branch that makes a tampered value fail
	// rather than decrypt to garbage a caller would go on to use. Both WebCrypto calls are
	// Promise-API edge work, and a rejection of either is a tampered or mis-keyed value — the
	// defected promise failure is mapped into the same `Rejected` the parsing checks return.
	return importKey(key, 'decrypt').pipe(
		Effect.flatMap((cipher) =>
			Effect.promise(() =>
				crypto.subtle.decrypt(
					{
						name: 'AES-GCM',
						iv: sourced(nonceBytes),
						additionalData: utf8(binding),
						tagLength: TAG_BYTES * 8
					},
					cipher,
					joined
				)
			)
		),
		Effect.catchDefect(() => Effect.succeed(null)),
		Effect.map((outcome) =>
			outcome === null
				? {
						_tag: 'Rejected' as const,
						reason:
							'it failed its authentication tag, so it was altered, was written under a different key, or belongs to a different row'
					}
				: { _tag: 'Value' as const, value: new TextDecoder().decode(outcome) }
		)
	);
};

/**
 * How this cipher obtains its key, as a seam rather than an assumption.
 *
 * `ConfigProvider` is one answer and it is the wrong one in the place that matters most. A tenant
 * runtime executes inside a `vm` context with no `process` global, deliberately — so a bundle that
 * reads configuration through the ambient provider inside an isolate reads nothing, silently, and
 * every `encrypt` refuses with "the key is not set" on a host where the key is very much set. That
 * is the same fault that made the gateway secret unreachable and every `schema.migrate` answer
 * "Missing command credential" while the bootstrap reported six of six up.
 *
 * A host behind an isolate boundary answers through its config facility instead, which is a round
 * trip it can actually serve. Both routes produce the same `Option`, and the failure channel carries
 * the reason a route could not answer, so "the host has no key" and "the host could not be asked"
 * stay distinguishable — they mean different things to an operator, and both are fatal to a write.
 */
export type KeySource = Readonly<{
	readonly read: (key: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, string>;
}>;

/** The key source a bundle running in a plain process has: Effect's own configuration provider. */
export const configProviderKeySource: KeySource = {
	read: (key) =>
		Config.option(Config.redacted(key)).pipe(
			Effect.mapError(() => `${key} could not be read from configuration`)
		)
};

/**
 * The cipher over one key source.
 *
 * The key is read once, at layer construction, and never from `process.env` directly — Bolt
 * describes a workspace and a host runs it, so ambient environment access is an architecture
 * violation the dependency audit fails on, and Colony bans `process.env` outside its one env loader
 * for the same reason.
 *
 * A source *failure* collapses to the same `Unavailable` an absent key produces. That is the
 * fail-closed direction: not being able to tell whether a key exists means there is no key to
 * encrypt with, and every write refuses. The reason is carried through, so the two cases read
 * differently in the message an operator sees.
 */
export const layerFrom = (source: KeySource) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const material = yield* source.read(SECRET_KEY_VARIABLE).pipe(
				Effect.match({
					onFailure: (reason): KeyMaterial => ({ _tag: 'Unavailable', reason }),
					onSuccess: resolveKey
				})
			);

			const encrypt: Interface['encrypt'] = Effect.fn('SecretCipher.encrypt')(function* (
				operation: string,
				binding: string,
				value: string
			) {
				if (material._tag === 'Unavailable')
					return yield* new SecretKeyUnavailable({ operation, reason: material.reason });
				return yield* seal(Redacted.value(material.key), binding, value);
			});

			const decrypt: Interface['decrypt'] = Effect.fn('SecretCipher.decrypt')(function* (
				name: string,
				binding: string,
				stored: string
			) {
				if (material._tag === 'Unavailable')
					return yield* new SecretKeyUnavailable({
						operation: `reading ${name}`,
						reason: material.reason
					});
				const opened = yield* open(Redacted.value(material.key), binding, stored);
				if (opened._tag === 'Rejected')
					return yield* new SecretUnreadable({ name, reason: opened.reason });
				return opened.value;
			});

			return { encrypt, decrypt };
		})
	);

/**
 * The cipher for a host that is a plain process, which is Colony's own control-plane store.
 *
 * Kept as the default because that is what it is: the browser-session vault lives host-side, in
 * Colony's own database, in a process that has an environment. Only the *tenant* runtime lacks one.
 */
export const layer = layerFrom(configProviderKeySource);

export const SecretCipher = {
	Service,
	layer,
	layerFrom,
	configProviderKeySource,
	SecretKeyUnavailable,
	SecretUnreadable,
	SECRET_KEY_VARIABLE,
	bind
};
