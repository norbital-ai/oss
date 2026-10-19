// Test acquisition uses the same native graph and the caller's scope; it never adds a Promise facade.
import { Layer, Option } from 'effect';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Activation } from '../src/engine/services.ts';
import {
	Ai,
	Convert,
	DeadlinePort,
	Drivers,
	Files,
	Geo,
	Metering,
	Speech,
	Transport,
	WebRead
} from '../src/engine/ports.ts';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { EngineLive } from '../src/engine/host.ts';
import type { GuestProgram } from '../src/engine/guest/runner.ts';

export const acquireEngine = (manifest: EngineManifest, db: TenantDbShape, guest?: GuestProgram) =>
	Layer.build(
		EngineLive(manifest).pipe(
			Layer.provide(
				Layer.mergeAll(
					NodeCrypto.layer,
					Layer.succeed(TenantDb, db),
					Ai.unavailable,
					Convert.unavailable,
					DeadlinePort.unavailable,
					Drivers.unavailable,
					Files.unavailable,
					Geo.unavailable,
					Metering.unavailable,
					Speech.unavailable,
					Transport.unavailable,
					WebRead.unavailable,
					Layer.succeed(Activation, {
						scope: 'test',
						epoch: '',
						release: 'test',
						publicUrl: 'http://localhost',
						guest: Option.fromNullishOr(guest),
						transforms: new Set<string>(),
						projections: new Set<string>(),
						start: [],
						secretsKey: Option.none()
					})
				)
			)
		)
	);
