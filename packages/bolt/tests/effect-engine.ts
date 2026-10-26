// Test acquisition uses the same native graph and the caller's scope; it never adds a Promise facade.
import { Effect, Layer, Option } from 'effect';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Activation } from '../src/engine/services.ts';
import {
	Ai,
	Convert,
	DeadlinePort,
	Drivers,
	Files,
	Geo,
	GuestIsolates,
	Http,
	Docs,
	Images,
	Keys,
	Mcp,
	Metering,
	Speech,
	Transport,
	WebRead
} from '../src/engine/ports.ts';
import { nodePorts } from '../src/node/ports.ts';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { EngineLive } from '../src/engine/host.ts';
import { memoryAuditLayer } from '../src/test/index.ts';
import type { GuestProgram } from '../src/engine/guest/runner.ts';

export const acquireEngine = (manifest: EngineManifest, db: TenantDbShape, guest?: GuestProgram) =>
	Layer.build(
		EngineLive(manifest).pipe(
			Layer.provide(
				Layer.mergeAll(
					// governed mutations (member administration, runs, transactions) fail closed without a facility
					memoryAuditLayer,
					NodeCrypto.layer,
					NodeFileSystem.layer,
					NodePath.layer,
					Layer.unwrap(
						Effect.map(nodePorts(), (ports) => GuestIsolates.fromAbi(ports.guestIsolates))
					),
					Keys.unavailable,
					Http.unavailable,
					Images.unavailable,
					Docs.unavailable,
					Mcp.unavailable,
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
						start: []
					})
				)
			)
		)
	);
