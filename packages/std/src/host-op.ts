// std/host-op (§7.1 "Operations"): the one signed-host-operation scheme for hosts and their operator CLIs. A MAC
// (HMAC-SHA256, base64url) over the newline-joined `v1 · scope · host · op · ts · nonce · sha256(body)`, carried in the
// `bolt-op-*` headers. A request older or newer than five minutes, one for another scope, host or operation, a bad MAC
// and a replayed nonce are refused before the body is read as an operation. Nonces are durable: the host's `NonceStore`.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Clock, Effect, Schema } from 'effect';

/** The request headers a signed operation travels in: its name, timestamp (epoch ms), nonce and MAC. */
export const OP_HEADERS = {
	op: 'bolt-op-name',
	ts: 'bolt-op-ts',
	nonce: 'bolt-op-nonce',
	mac: 'bolt-op-mac'
} as const;
/** How far a signature's timestamp may be from the verifier's clock, either way. */
export const OP_WINDOW_MS = 5 * 60_000;
/** The secret and the scope it signs for: a workspace handle (bolt-server) or a platform deployment environment. */
export type OpKey = { readonly secret: string | Uint8Array; readonly scope: string };
/**
 * Where a host keeps the nonces it has accepted. `claim` succeeds with `true` the first time a nonce is offered and
 * `false` after, across restarts; `at` (epoch ms) lets the store prune nonces older than `OP_WINDOW_MS`.
 */
export interface NonceStore<E = never> {
	claim(nonce: string, at: number): Effect.Effect<boolean, E>;
}

/** Why a signed operation was refused: no or malformed signature, outside the window, a bad MAC, or a replayed nonce. */
export class OpRefused extends Schema.TaggedError<OpRefused>()('OpRefused', {
	reason: Schema.Literals(['unsigned', 'stale', 'badSignature', 'replayed'])
}) {}

const NONCE = /^[\w-]{16,128}$/;
const macOf = (
	key: OpKey,
	host: string,
	op: string,
	ts: string,
	nonce: string,
	body: string | Uint8Array
): Buffer =>
	createHmac('sha256', key.secret)
		.update(
			['v1', key.scope, host, op, ts, nonce, createHash('sha256').update(body).digest('hex')].join(
				'\n'
			)
		)
		.digest();

/** The headers one operation carries to `host` (the `Host` the verifier sees in the request URL). */
export function signOp(
	key: OpKey,
	host: string,
	op: string,
	body: string | Uint8Array,
	now: number,
	nonce: string = randomUUID()
): { readonly [header: string]: string } {
	const ts = String(now);
	return {
		[OP_HEADERS.op]: op,
		[OP_HEADERS.ts]: ts,
		[OP_HEADERS.nonce]: nonce,
		[OP_HEADERS.mac]: macOf(key, host, op, ts, nonce, body).toString('base64url')
	};
}

/** The operation name of an authentic, fresh, first-seen request; else `OpRefused` (the nonce is claimed last). */
export const verifyOp = <E>(
	key: OpKey,
	request: Request,
	body: string | Uint8Array,
	nonces: NonceStore<E>
): Effect.Effect<string, OpRefused | E> =>
	Effect.gen(function* () {
		const h = (name: string) => request.headers.get(name) ?? '';
		const [op, ts, nonce, mac] = [
			h(OP_HEADERS.op),
			h(OP_HEADERS.ts),
			h(OP_HEADERS.nonce),
			h(OP_HEADERS.mac)
		];
		if (op === '' || !NONCE.test(nonce) || !/^\d+$/.test(ts))
			return yield* new OpRefused({ reason: 'unsigned' });
		const now = yield* Clock.currentTimeMillis;
		if (Math.abs(now - Number(ts)) > OP_WINDOW_MS) return yield* new OpRefused({ reason: 'stale' });
		const want = macOf(key, new URL(request.url).host, op, ts, nonce, body),
			got = Buffer.from(mac, 'base64url');
		if (got.length !== want.length || !timingSafeEqual(got, want))
			return yield* new OpRefused({ reason: 'badSignature' });
		if (!(yield* nonces.claim(nonce, now))) return yield* new OpRefused({ reason: 'replayed' });
		return op;
	});
