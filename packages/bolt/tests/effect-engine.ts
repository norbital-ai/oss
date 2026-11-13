// Test acquisition uses the same native graph and the caller's scope; it never adds a Promise facade.
import { Effect, Layer, Option } from 'effect';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { randomBytes } from 'node:crypto';
import { refused, refused_files } from './support/refused.ts';
import { off } from '../src/facilities/index.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Activation } from '../src/engine/services.ts';
import {
	Browser,
	Convert,
	DeadlinePort,
	Drivers,
	Geo,
	Docs,
	GuestIsolates,
	Images,
	Mcp,
	Render,
	WebRead
} from '../src/engine/ports.ts';
import { node_ports } from '../src/node/ports.ts';
import { guests } from './support/guests.ts';
import { keys_port } from '../src/node/keys.ts';
import { tenant_db_port } from '../src/node/db/port.ts';
import { facility_layers } from '../src/protocol/facility-layers.ts';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { EngineLive } from '../src/engine/host.ts';
import { memory_audit } from '../../bolt-cli/src/test/index.ts';
import type { GuestProgram } from '../src/engine/guest/runner.ts';
import type { BrowserSnapshot } from '../src/decl/runtime/browser.ts';

export const browser_probe: { calls: { profile: string; url: string }[]; closes: string[] } = {
	calls: [],
	closes: []
};
const pages = new Map<string, BrowserSnapshot>();
const page = (profile: string): BrowserSnapshot => {
	const current = pages.get(profile);
	if (current === undefined) throw new Error(`The fixture browser profile ${profile} is not open.`);
	return current;
};
/**
 * A bare engine's host: the shared facility adapters over an in-memory audit and refusing members, everything optional
 * `off`. Merge a service after it to replace one (`Layer.merge(bare_host(db), Layer.succeed(Ai, ai))`).
 */
export const bare_host = (db: TenantDbShape, options: { readonly guest?: GuestProgram } = {}) =>
	Layer.unwrap(
		Effect.map(node_ports(), (ports) =>
			Layer.mergeAll(
				facility_layers({
					storage: {
						database: tenant_db_port(db),
						files: refused_files
					},
					logs: { runtime: { write: () => {}, query: async () => [] }, audit: memory_audit().port },
					transactional: {
						mail: { send: refused('email') },
						sms: off,
						phone: off,
						push: off,
						challenge: off,
						fixed_codes: false
					},
					intelligence: { system1: off, system2: off, embed: off },
					ports: { webhooks: off, websockets: off, outbound: off },
					sandbox: off,
					keys: keys_port(randomBytes(32))
				}),
				GuestIsolates.fromAbi(guests),
				Images.fromAbi(ports.images),
				Docs.fromAbi(ports.docs),
				Mcp.fromAbi(ports.mcp),
				Convert.fromAbi(off),
				Render.fromAbi(off),
				Browser.fromAbi({
					open: async (profile) => {
						pages.set(profile, { url: 'about:blank', title: null, text: '' });
					},
					navigate: async (profile, to) => {
						const url = 'url' in to ? to.url : to.go;
						browser_probe.calls.push({ profile, url });
						const current = { ...page(profile), url: 'url' in to ? to.url : page(profile).url };
						pages.set(profile, current);
						return current;
					},
					snapshot: async (profile) => page(profile),
					act: async (profile) => page(profile),
					evaluate: async () => null,
					screenshot: async () => new Uint8Array(),
					download: async () => ({
						key: 'k',
						sha256: 'a'.repeat(64),
						name: 'file',
						mime: 'image/png',
						bytes: 1
					}),
					close: async (profile) => {
						pages.delete(profile);
						browser_probe.closes.push(profile);
					}
				}),
				WebRead.fromAbi(off),
				Geo.fromAbi(off),
				Drivers.fromAbi(off),
				DeadlinePort.fromAbi({ announce: async () => {}, settle: async () => {}, teardown: async () => {} }),
				NodeCrypto.layer,
				NodeFileSystem.layer,
				NodePath.layer,
				Layer.succeed(TenantDb, db),
				Layer.succeed(Activation, {
					scope: 'test',
					epoch: '',
					release: 'test',
					public_url: 'http://localhost',
					guest: Option.fromNullishOr(options.guest)
				})
			)
		)
	);

export const acquire_engine = (manifest: EngineManifest, db: TenantDbShape, guest?: GuestProgram) =>
	Layer.build(
		EngineLive(manifest).pipe(Layer.provide(bare_host(db, guest === undefined ? {} : { guest })))
	);
