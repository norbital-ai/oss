// The guest fixture manifest and a native guest activation without a database.
import { Effect, Layer, Option, Result } from 'effect';
import { decode_projected_manifest } from '../../src/engine/manifest.ts';
import {
	GuestConfig,
	GuestLive,
	type GuestOptions,
	type GuestProgram
} from '../../src/engine/guest/runner.ts';
import { GuestIsolates } from '../../src/engine/ports.ts';
import { guests } from './guests.ts';
import {
	Activation,
	Manifest,
	Telemetry,
	type EventIds,
	type InvocationEvents
} from '../../src/engine/services.ts';

export const fixture_manifest = Result.getOrThrow(
	decode_projected_manifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {},
		relationships: {},
		exposures: {
			a: { outputs: { default: { a: { fields: 'all' } } }, create: { columns: { a: [] } } },
			b: { outputs: { default: { b: { fields: 'all' } } }, update: { columns: { b: [] } } },
			t: {
				outputs: { default: { t: { fields: 'all' } } },
				create: { columns: { t: [] } }
			},
			jobs: { outputs: { default: { jobs: { fields: 'all' } } }, update: { columns: { jobs: [] } } }
		},
		policies: { fixture: { description: 'Guest fixture authority', grants: {} } },
		automations: {
			a: { description: 'a', policies: ['fixture'] },
			b: { description: 'b', policies: ['fixture'] }
		},
		integrations: {},
		teams: {},
		mcp: {},
		apps: {},
		groups: {},
		custom_fields: {},
		agent: { skills: {} }
	})
);
/** A native guest activation without a database; tests supply the crossing host. */
export const guest_layer = (
	guest: GuestProgram,
	options: GuestOptions = {},
	events?: (ids: EventIds) => Effect.Effect<InvocationEvents>,
	isolates: Layer.Layer<GuestIsolates> = GuestIsolates.fromAbi(guests)
) =>
	GuestLive.pipe(
		Layer.provideMerge(isolates),
		Layer.provideMerge(
			Layer.mergeAll(
				Layer.succeed(GuestConfig, options),
				Layer.succeed(Manifest, fixture_manifest),
				Layer.succeed(Activation, {
					scope: 'test',
					epoch: '',
					release: 'test',
					public_url: 'http://localhost',
					guest: Option.some(guest)
				}),
				Layer.succeed(Telemetry, {
					open: events ?? (() => Effect.succeed({ emit: () => Effect.void }))
				})
			)
		)
	);
