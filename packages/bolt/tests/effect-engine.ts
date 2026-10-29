// Test acquisition uses the same native graph and the caller's scope; it never adds a Promise facade.
import { Effect, Layer, Option } from 'effect';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { randomBytes } from 'node:crypto';
import { refused, refusedFiles } from './support/refused.ts';
import { off } from '../src/facilities/index.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Activation } from '../src/engine/services.ts';
import {
	Convert,
	DeadlinePort,
	Drivers,
	Geo,
	Docs,
	GuestIsolates,
	Images,
	Mcp,
	WebRead
} from '../src/engine/ports.ts';
import { nodePorts } from '../src/node/ports.ts';
import { guests } from './support/guests.ts';
import { keysPort } from '../src/node/keys.ts';
import { tenantDbPort } from '../src/node/db/port.ts';
import { facilityLayers } from '../src/protocol/host-api.ts';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { EngineLive } from '../src/engine/host.ts';
import { memoryAudit } from '../../bolt-cli/src/test/index.ts';
import type { GuestProgram } from '../src/engine/guest/runner.ts';

/**
 * A bare engine's host: the shared facility adapters over an in-memory audit and refusing members, everything optional
 * `off`. Merge a service after it to replace one (`Layer.merge(bareHost(db), Layer.succeed(Ai, ai))`).
 */
export const bareHost = (db: TenantDbShape, options: { readonly guest?: GuestProgram } = {}) =>
	Layer.unwrap(
		Effect.map(nodePorts(), (ports) =>
			Layer.mergeAll(
				facilityLayers({
					storage: {
						database: tenantDbPort(db),
						files: refusedFiles
					},
					logs: { runtime: { write: () => {}, query: async () => [] }, audit: memoryAudit().port },
					transactional: {
						mail: { send: refused('email') },
						sms: off,
						phone: off,
						push: off,
						challenge: off,
						fixedCodes: false
					},
					intelligence: { system1: off, system2: off, embed: off, speech: off },
					ports: { webhooks: off, websockets: off, outbound: off },
					sandbox: off,
					keys: keysPort(randomBytes(32))
				}),
				GuestIsolates.fromAbi(guests),
				Images.fromAbi(ports.images),
				Docs.fromAbi(ports.docs),
				Mcp.fromAbi(ports.mcp),
				Convert.fromAbi(off),
				WebRead.fromAbi(off),
				Geo.fromAbi(off),
				Drivers.fromAbi(off),
				DeadlinePort.fromAbi({ announce: () => {}, settle: () => {}, teardown: () => {} }),
				NodeCrypto.layer,
				NodeFileSystem.layer,
				NodePath.layer,
				Layer.succeed(TenantDb, db),
				Layer.succeed(Activation, {
					scope: 'test',
					epoch: '',
					release: 'test',
					publicUrl: 'http://localhost',
					guest: Option.fromNullishOr(options.guest)
				})
			)
		)
	);

export const acquireEngine = (manifest: EngineManifest, db: TenantDbShape, guest?: GuestProgram) =>
	Layer.build(
		EngineLive(manifest).pipe(Layer.provide(bareHost(db, guest === undefined ? {} : { guest })))
	);
