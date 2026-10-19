// Google Calendar under bolt's own links manager and engine (PGlite), over a fake Google: the link watches the calendars
// the instance's configuration names when it opens; a committed change of that configuration reopens it, so a newly
// added calendar gets its watch and a removed one's watch is stopped at Google and dropped from the sealed state.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { EngineManifestSchema, layered, type Json } from '@norbital-ai/bolt/engine';
import { googleCalendar } from '../src/google-calendar/index.ts';
import { fakeFetch, json, until } from './kit.ts';
import { engineHost } from './engine-host.ts';

const NOW = Date.parse('2026-10-14T08:00:00Z');
const manifest = layered(
	Schema.decodeUnknownSync(EngineManifestSchema)({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			calendar_entries: {
				description: 'A calendar event',
				label: 'title',
				key: ['account', 'calendar', 'external'],
				fields: { calendar: { kind: 'text' }, external: { kind: 'text' }, title: { kind: 'text' } }
			}
		},
		relationships: {
			'calendar_entries.account': {
				to: 'sys_integration',
				where: { integration: { eq: 'google_calendar' } }
			}
		},
		collections: { calendar_entries: { read: { fields: 'all' } } },
		integrations: {
			google_calendar: {
				description: 'Calendars',
				driver: 'calendar',
				oauth: { client: 'GOOGLE_CLIENT', secret: 'GOOGLE_SECRET' },
				configuration: { calendars: { kind: 'text', many: true, default: [] } },
				feeds: {
					events: {
						into: 'calendar_entries',
						key: ['calendar', 'external'],
						from: 'driver',
						partitions: 'calendars'
					}
				}
			}
		},
		pipelines: {},
		policies: {},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);

const WatchRequest = Schema.fromJsonString(Schema.Struct({ id: Schema.String }));
const StopRequest = Schema.fromJsonString(Schema.Struct({ resourceId: Schema.String }));
const Watches = Schema.Struct({
	watches: Schema.Array(Schema.Struct({ calendar: Schema.String, phase: Schema.String }))
});

const google = () =>
	fakeFetch([
		(c) =>
			c.url.endsWith('/events/watch')
				? json({
						id: Schema.decodeUnknownSync(WatchRequest)(c.body).id,
						resourceId: `res-${decodeURIComponent(c.url.split('/calendars/')[1]!.split('/')[0]!)}`,
						expiration: String(NOW + 3_600_000)
					})
				: undefined,
		(c) => (c.url.endsWith('/channels/stop') ? new Response(null, { status: 204 }) : undefined)
	]);
const watched = (f: ReturnType<typeof google>) =>
	f.calls
		.filter((c) => c.url.endsWith('/events/watch'))
		.map((c) => decodeURIComponent(c.url.split('/calendars/')[1]!.split('/')[0]!));
const stopped = (f: ReturnType<typeof google>) =>
	f.calls
		.filter((c) => c.url.endsWith('/channels/stop'))
		.map((c) => Schema.decodeUnknownSync(StopRequest)(c.body).resourceId);

// a PGlite engine host per test: bolt's integration budget, not the 5 s unit default
describe('the Google Calendar link on a host', { timeout: 15_000 }, () => {
	it.live(
		'a calendar added to the configuration gets a watch, and a removed one’s watch stops',
		() =>
			engineHost(
				{
					manifest,
					now: new Date(NOW).toISOString(),
					seed: {
						sys_integration: [
							{
								id: 'cal1',
								integration: 'google_calendar',
								name: 'Ana',
								configuration: { calendars: ['visits@example.com'] }
							}
						]
					}
				},
				({ t, store, links }) =>
					Effect.gen(function* () {
						const o = yield* store.open('cal1');
						yield* store.write(
							'cal1',
							o.epoch,
							new Map<string, Json>([
								['provider', 'google'],
								['token', { access: 'at-1', refresh: 'rt-1', exp: NOW + 3_600_000 }]
							])
						);
						const f = google();
						const secrets: Readonly<Record<string, string>> = {
							GOOGLE_CLIENT: 'client-1',
							GOOGLE_SECRET: 'shh'
						};
						const manager = yield* links([googleCalendar()], {
							publicUrl: 'https://apex.example/acme',
							secrets,
							fetch: f
						});
						yield* manager.resume;
						yield* until(() => watched(f).length === 1);
						expect(watched(f)).toEqual(['visits@example.com']);
						const stored = yield* t.storedRead('sys_integration', {
							all: true,
							select: { id: true }
						});
						const calendar = stored.rows.find((row) => row.id === 'cal1');
						if (calendar === undefined)
							throw new Error('The seeded calendar integration is missing.');
						const act = yield* t.as(t.admin).act('sys_integration.update', {
							target: calendar.id,
							set: { configuration: { calendars: ['team@example.com'] } }
						});
						expect(act.kind).toBe('committed');
						yield* until(() => watched(f).length === 2 && stopped(f).length === 1);
						expect(watched(f)).toEqual(['visits@example.com', 'team@example.com']);
						expect(stopped(f)).toEqual(['res-visits@example.com']);
						// the sealed watches follow: the removed calendar's is gone, the added one's active
						const watches = () =>
							store.read('cal1').pipe(
								Effect.flatMap((stored) =>
									Schema.decodeUnknownEffect(Watches)(stored.values.get('state'))
								),
								Effect.map((state) => state.watches)
							);
						for (
							let i = 0;
							i < 200 &&
							(yield* watches()).some(
								(w) => w.phase !== 'active' || w.calendar !== 'team@example.com'
							);
							i++
						)
							yield* Effect.sleep('10 millis');
						expect((yield* watches()).map((w) => [w.calendar, w.phase])).toEqual([
							['team@example.com', 'active']
						]);
						yield* manager.close;
					})
			)
	);
});
