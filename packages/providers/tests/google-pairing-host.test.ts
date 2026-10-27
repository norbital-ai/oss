import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { EngineManifestSchema } from '@norbital-ai/bolt/engine';
import { googleCalendar } from '../src/google-calendar/index.ts';
import { mailbox } from '../src/imap-smtp/index.ts';
import { engineHost } from './engine-host.ts';
import { fakeFetch } from './kit.ts';

const manifest = Schema.decodeUnknownSync(EngineManifestSchema)({
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	pipelines: {},
	integrations: {
		gmail: {
			description: 'Mail',
			driver: 'email',
			oauth: { client: 'GOOGLE_CLIENT', secret: 'GOOGLE_SECRET' }
		},
		google_calendar: {
			description: 'Calendar',
			driver: 'calendar',
			oauth: { client: 'GOOGLE_CLIENT', secret: 'GOOGLE_SECRET' }
		}
	},
	connections: { gmail: { integration: 'gmail' }, calendar: { integration: 'google_calendar' } },
	policies: {},
	teams: {},
	automations: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
});

describe('Google pairing on a host', { timeout: 15_000 }, () => {
	it.live('an unfinished sign-in restarts unpaired, can pair again, and cancels completely', () =>
		engineHost({ manifest }, ({ store, links }) =>
			Effect.gen(function* () {
				const providers = [
					...mailbox().filter((provider) => provider.id === 'google'),
					googleCalendar()
				];
				const fetch = fakeFetch([]);
				const options = {
					publicUrl: 'https://apex.example/acme',
					secrets: { GOOGLE_CLIENT: 'client-1', GOOGLE_SECRET: 'secret' },
					fetch
				};
				const first = yield* links(providers, options);
				for (const instance of ['gmail', 'calendar']) {
					yield* first.pair(instance, {});
					expect(yield* first.state(instance)).toMatchObject({
						state: 'pairing',
						stored: true,
						pairing: { kind: 'oauth', value: expect.stringContaining('accounts.google.com') }
					});
					expect(Object.fromEntries((yield* store.read(instance)).values)).toEqual({
						provider: 'google'
					});
				}
				yield* first.close;
				const second = yield* links(providers, options);
				yield* second.resume;
				for (const instance of ['gmail', 'calendar']) {
					expect(yield* second.state(instance)).toMatchObject({
						state: 'unpaired',
						stored: true,
						pairing: null
					});
					yield* second.pair(instance, {});
					const paired = yield* second.state(instance);
					expect(paired).toMatchObject({ state: 'pairing', pairing: { kind: 'oauth' } });
					const value = paired?.pairing?.value;
					if (typeof value !== 'string') throw new Error('Missing Google sign-in URL');
					const url = new URL(value);
					expect(url.origin).toBe('https://accounts.google.com');
					expect(url.searchParams.get('client_id')).toBe('client-1');
					yield* second.unpair(instance);
					expect(yield* second.state(instance)).toMatchObject({ state: 'unpaired', stored: false });
					expect((yield* store.read(instance)).values.size).toBe(0);
					const callback = new URL('https://apex.example/acme/hooks/oauth/callback');
					callback.searchParams.set('state', url.searchParams.get('state') ?? '');
					callback.searchParams.set('code', 'cancelled');
					expect((yield* second.callback(new Request(callback))).status).toBe(400);
				}
				expect(fetch.calls).toEqual([]);
				yield* second.close;
			})
		)
	);
});
