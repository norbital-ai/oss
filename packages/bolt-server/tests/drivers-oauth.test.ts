// bolt-server's own `http` driver signs an OAuth definition in through the providers' shared grant: PKCE S256 on the
// authorize URL, a callback state that is this link's own attempt and lives `STATE_MS`, the code exchanged with the
// attempt's verifier. A foreign or expired state never reaches the token endpoint.
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import type { DriverOpen } from '@norbital-ai/bolt/engine';
import { STATE_MS } from '@norbital-ai/providers';
import { fakeFetch, host, json, REDIRECT } from '../../providers/tests/kit.ts';
import { httpProvider } from '../src/drivers.ts';

const TOKEN = 'https://crm.example/token';
const definition: DriverOpen['definition'] = {
	description: 'The CRM',
	driver: 'http',
	http: { baseUrl: 'https://crm.example/v1' },
	oauth: {
		client: 'CRM_CLIENT',
		secret: 'CRM_SECRET',
		authorize: 'https://crm.example/authorize?prompt=consent',
		token: TOKEN,
		scopes: ['read']
	}
};

/** A CRM link that started its sign-in: the authorize URL it published, its state, its callback, and the clock. */
const signIn = Effect.fn('HttpOAuthTest.signIn')(function* (
	answer = () =>
		json({ access_token: 'crm-access', refresh_token: 'crm-refresh', expires_in: 3600 })
) {
	yield* TestClock.setTime(Date.parse('2026-10-14T09:00:00Z'));
	const f = fakeFetch([(c) => (c.url === TOKEN ? answer() : undefined)]);
	const h = yield* host(
		httpProvider({ fetch: f }),
		f,
		{},
		{ definition, secrets: { CRM_CLIENT: 'crm-client', CRM_SECRET: 'crm-secret' } }
	);
	if (h.link.pair === undefined || h.link.webhook === undefined)
		throw new Error('HTTP OAuth link is missing a declared capability.');
	const { pair, webhook } = h.link;
	yield* pair({});
	if (typeof h.pairing?.value !== 'string')
		throw new Error('The OAuth authorize URL was not published.');
	const authorize = new URL(h.pairing.value);
	const state = authorize.searchParams.get('state');
	if (state === null) throw new Error('The OAuth authorize URL has no state.');
	const callback = (s: string) =>
		webhook(new Request(`${REDIRECT}?code=c1&state=${encodeURIComponent(s)}`)).pipe(
			Effect.map((response) => response.status)
		);
	const exchanges = () => f.calls.filter((c) => c.url === TOKEN);
	return {
		h,
		authorize,
		state,
		callback,
		exchanges,
		advance: (ms: number) => TestClock.adjust(ms)
	};
});

describe('http driver OAuth sign-in', () => {
	it.effect(
		'publishes an authorize URL carrying a PKCE S256 challenge beside the definition’s own query',
		() =>
			Effect.gen(function* () {
				const { authorize, state } = yield* signIn();
				expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
					prompt: 'consent',
					response_type: 'code',
					client_id: 'crm-client',
					redirect_uri: REDIRECT,
					scope: 'read',
					code_challenge_method: 'S256'
				});
				expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
				expect(state).toMatch(/\.desk$/);
			})
	);

	it.effect(
		'exchanges the code with the verifier its challenge was derived from, stores the token, and spends the state',
		() =>
			Effect.gen(function* () {
				const { h, authorize, state, callback, exchanges } = yield* signIn();
				expect(yield* callback(state)).toBe(200);
				const [exchange] = exchanges(),
					body = new URLSearchParams(exchange?.body);
				expect(Object.fromEntries(body)).toMatchObject({
					grant_type: 'authorization_code',
					code: 'c1',
					redirect_uri: REDIRECT,
					client_id: 'crm-client',
					client_secret: 'crm-secret'
				});
				expect(
					createHash('sha256')
						.update(body.get('code_verifier') ?? '')
						.digest('base64url')
				).toBe(authorize.searchParams.get('code_challenge'));
				expect(h.values.get('token')).toMatchObject({
					access: 'crm-access',
					refresh: 'crm-refresh'
				});
				expect(h.status).toEqual({ state: 'connected' });
				expect(yield* callback(state)).toBe(400);
				expect(exchanges()).toHaveLength(1);
			})
	);

	it.effect(
		'refuses a foreign state for this instance without spending the code; its own attempt still stands',
		() =>
			Effect.gen(function* () {
				const { state, callback, exchanges } = yield* signIn();
				expect(yield* callback(state.replace(/^[^.]*/, randomUUID()))).toBe(400);
				expect(exchanges()).toHaveLength(0);
				expect(yield* callback(state)).toBe(200);
			})
	);

	it.effect('refuses its own state once STATE_MS has passed', () =>
		Effect.gen(function* () {
			const { state, callback, exchanges, advance } = yield* signIn();
			yield* advance(STATE_MS + 1);
			expect(yield* callback(state)).toBe(400);
			expect(exchanges()).toHaveLength(0);
		})
	);

	it.effect('reports a refused exchange as an error and stores no token', () =>
		Effect.gen(function* () {
			const { h, state, callback } = yield* signIn(() => json({ error: 'invalid_grant' }, 400));
			expect(yield* callback(state)).toBe(400);
			expect(h.status?.state).toBe('error');
			expect(h.values.has('token')).toBe(false);
		})
	);
});
