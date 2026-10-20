// OAuth owned by the instance's link (a mailbox, a calendar): the tenant's own app registration, authorization code with
// PKCE, the callback on the host's one redirect URI (routed back to the link by its `state`), and refresh on use. Nothing
// here is tied to a member: the `state` is bound to one pairing attempt and lives ten minutes.
import { createHash, randomBytes } from 'node:crypto';
import { Clock, Effect, Fiber, Schema, Scope, Semaphore, SynchronizedRef } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';
import { OAuthRefused, ProviderUnavailable, type ProviderFailure } from './errors.ts';
import { same } from './util.ts';

/** Where a provider's authorization server is, and what the mailbox needs from it. */
export type OAuthApp = {
	authorizeUrl: string;
	tokenUrl: string;
	scopes: readonly string[];
	params?: { readonly [k: string]: string };
};
export const Tokens = Schema.Struct({
	access: Schema.NonEmptyString,
	refresh: Schema.NullOr(Schema.String),
	exp: Schema.Number
});
export type Tokens = typeof Tokens.Type;

export const STATE_MS = 10 * 60_000;

/** One accepted callback completes once; popup/navigation retries receive independent copies of its response. */
export const callbackCompletion = Effect.gen(function* () {
	const gate = yield* Semaphore.make(1),
		scope = yield* Scope.Scope;
	let completed: {
		state: string;
		at: number;
		fiber: Fiber.Fiber<Response, ProviderFailure>;
	} | null = null;
	return {
		reset: <A, E, R>(work: Effect.Effect<A, E, R>) =>
			gate.withPermit(
				Effect.gen(function* () {
					if (completed !== null) yield* Fiber.interrupt(completed.fiber);
					completed = null;
					return yield* work;
				})
			),
		run: <P extends { state: string; at: number }>(
			state: string,
			pending: () => P | null,
			expired: () => Response,
			complete: (pairing: P) => Effect.Effect<Response, ProviderFailure>
		) =>
			Effect.gen(function* () {
				const selected = yield* gate.withPermit(
					Effect.gen(function* () {
						const now = yield* Clock.currentTimeMillis;
						if (completed !== null && now - completed.at > STATE_MS) {
							yield* Fiber.interrupt(completed.fiber);
							completed = null;
						}
						if (completed !== null && same(state, completed.state)) return completed.fiber;
						const pairing = pending();
						if (pairing === null || !same(state, pairing.state) || now - pairing.at > STATE_MS)
							return expired();
						// A canceled HTTP waiter must not leave an untracked completion running in the link.
						return yield* Effect.forkIn(Effect.scoped(complete(pairing)), scope, {
							uninterruptible: false
						}).pipe(
							Effect.tap((fiber) =>
								Effect.sync(() => {
									completed = { state: pairing.state, at: pairing.at, fiber };
								})
							),
							Effect.uninterruptible
						);
					})
				);
				return selected instanceof Response ? selected : (yield* Fiber.join(selected)).clone();
			})
	};
});
const SKEW_MS = 60_000;
const Grant = Schema.Struct({
	access_token: Schema.optionalKey(Schema.String),
	refresh_token: Schema.optionalKey(Schema.String),
	expires_in: Schema.optionalKey(Schema.Number),
	error: Schema.optionalKey(Schema.String),
	error_description: Schema.optionalKey(Schema.String)
});

/** One sign-in attempt: the `state` the callback must echo (the host's, `DriverOpen.state()`) and the PKCE verifier its code is exchanged with. */
export function attempt(state: string): { state: string; verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString('base64url');
	return { state, verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(
	app: OAuthApp,
	clientId: string,
	redirect: string,
	state: string,
	challenge: string,
	hint?: string
): string {
	const url = new URL(app.authorizeUrl);
	for (const [k, v] of Object.entries({
		...app.params,
		response_type: 'code',
		client_id: clientId,
		redirect_uri: redirect,
		state,
		code_challenge: challenge,
		code_challenge_method: 'S256',
		...(hint === undefined ? {} : { login_hint: hint })
	}))
		url.searchParams.set(k, v);
	// no scope declared: the authorize URL's own query, else the server's default (an empty `scope` is malformed, RFC 6749 §3.3)
	if (app.scopes.length > 0) url.searchParams.set('scope', app.scopes.join(' '));
	return url.href;
}

/** One token request (`authorization_code` or `refresh_token`). */
export const grant = Effect.fn('OAuth.grant')(function* (
	app: OAuthApp,
	client: { id: string; secret: string },
	params: { readonly [k: string]: string }
) {
	const response = yield* HttpClient.execute(
		HttpClientRequest.post(app.tokenUrl, { acceptJson: true }).pipe(
			HttpClientRequest.bodyUrlParams({
				...params,
				client_id: client.id,
				client_secret: client.secret
			})
		)
	).pipe(
		Effect.mapError(
			() => new ProviderUnavailable({ message: 'the sign-in server could not be reached' })
		)
	);
	const body = yield* HttpClientResponse.schemaBodyJson(Grant)(response).pipe(
		Effect.mapError(
			() =>
				new ProviderUnavailable({
					message: 'the sign-in server answered something that is not a token',
					status: response.status
				})
		)
	);
	if (response.status >= 400 || !body.access_token) {
		const code = body.error ?? String(response.status);
		if (response.status === 429 || response.status >= 500)
			return yield* Effect.fail(
				new ProviderUnavailable({
					message: `the sign-in server answered ${response.status}`,
					status: response.status
				})
			);
		return yield* Effect.fail(
			new OAuthRefused({
				message: `the sign-in was refused (${code})${body.error_description === undefined ? '' : `: ${body.error_description.split('\n')[0]}`}`,
				revoked: ['invalid_grant', 'unauthorized_client', 'invalid_client'].includes(code)
			})
		);
	}
	return {
		access: body.access_token,
		refresh: body.refresh_token ?? null,
		exp: (yield* Clock.currentTimeMillis) + (body.expires_in ?? 3600) * 1000
	};
});

/** `t` if it is still good, else refreshed (the old refresh token kept when the provider does not rotate it). */
export const tokenHolder = Effect.fn('OAuth.tokenHolder')(function* (
	app: OAuthApp,
	client: () => Effect.Effect<{ id: string; secret: string }, ProviderUnavailable>,
	initial: Tokens | null,
	onRefresh: (tokens: Tokens) => Effect.Effect<void, ProviderFailure>
) {
	const held = yield* SynchronizedRef.make(initial);
	return {
		set: (tokens: Tokens | null) => SynchronizedRef.set(held, tokens),
		get: () =>
			SynchronizedRef.modifyEffect(held, (tokens) =>
				Effect.gen(function* () {
					if (tokens === null)
						return yield* Effect.fail(
							new OAuthRefused({ message: 'the instance is not signed in', revoked: true })
						);
					if (tokens.exp - SKEW_MS > (yield* Clock.currentTimeMillis))
						return [tokens, tokens] as const;
					if (tokens.refresh === null)
						return yield* Effect.fail(
							new OAuthRefused({
								message: 'the sign-in expired and gave no refresh token',
								revoked: true
							})
						);
					const granted = yield* grant(app, yield* client(), {
						grant_type: 'refresh_token',
						refresh_token: tokens.refresh,
						scope: app.scopes.join(' ')
					});
					const next = { ...granted, refresh: granted.refresh ?? tokens.refresh };
					yield* onRefresh(next);
					return [next, next] as const;
				})
			)
	};
});
