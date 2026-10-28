// The guest fixture manifest and a native guest activation without a database.
import { Effect, Layer, Option, Result } from 'effect';
import { decodeProjectedManifest } from '../../src/engine/manifest.ts';
import {
	GuestConfig,
	GuestLive,
	type GuestOptions,
	type GuestProgram
} from '../../src/engine/guest/runner.ts';
import { GuestIsolates } from '../../src/engine/ports.ts';
import { nodePorts } from '../../src/node/ports.ts';
import {
	Activation,
	Manifest,
	Telemetry,
	type EventIds,
	type InvocationEvents
} from '../../src/engine/services.ts';

export const fixtureManifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {},
		relationships: {},
		exposures: {
			a: { read: { a: { fields: 'all' } }, create: { columns: { a: [] } } },
			b: { read: { b: { fields: 'all' } }, update: { columns: { b: [] } } },
			t: {
				read: { t: { fields: 'all' } },
				create: { columns: { t: [] } }
			},
			jobs: { read: { jobs: { fields: 'all' } }, update: { columns: { jobs: [] } } }
		},
		policies: {},
		automations: {
			a: { description: 'a', runAs: 'trigger' },
			b: { description: 'b', runAs: 'trigger' }
		},
		integrations: {},
		teams: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		kiosks: {},
		groups: {},
		customFields: {},
		agent: { skills: {} }
	})
);
/** A native guest activation without a database; tests supply the crossing host. */
export const guestLayer = (
	guest: GuestProgram,
	options: GuestOptions = {},
	events?: (ids: EventIds) => Effect.Effect<InvocationEvents>,
	isolates: Layer.Layer<GuestIsolates> = Layer.unwrap(
		Effect.map(nodePorts(), (ports) => GuestIsolates.fromAbi(ports.guestIsolates))
	)
) =>
	GuestLive.pipe(
		Layer.provideMerge(isolates),
		Layer.provideMerge(
			Layer.mergeAll(
				Layer.succeed(GuestConfig, options),
				Layer.succeed(Manifest, fixtureManifest),
				Layer.succeed(Activation, {
					scope: 'test',
					epoch: '',
					release: 'test',
					publicUrl: 'http://localhost',
					guest: Option.some(guest),
					start: []
				}),
				Layer.succeed(Telemetry, {
					open: events ?? (() => Effect.succeed({ emit: () => Effect.void }))
				})
			)
		)
	);
