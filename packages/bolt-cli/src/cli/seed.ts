/// <reference types="node" />
// `bolt seed`: a bank tree's private rows, read into memory through `seed/+seeder.ts`, decoded, and
// sent to one environment of a host as signed operations: each asset (`seed.asset`, kept once by its digest), then
// the rows (`seed`), which the host restores over a reset of the environment. Nothing is written to either disk. The rows
// are first restored into a scratch database as the host restores them: a seed the host would refuse mid-restore fails
// before anything is sent, so the environment stays as it was.
import { createHash } from 'node:crypto';
import { Clock, Effect, FileSystem, Schema } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { sign_op } from '@norbital-ai/host-api/node';
import { Files, TenantDb, type EngineManifest } from '@norbital-ai/bolt/engine';
import { drain, memory_source, pack_asset_loader } from '@norbital-ai/bolt/tooling';
import { TestDb } from '../test/database.ts';
import { compile } from '../compiler/check/index.ts';
import { seedRows, type Seeding } from '../compiler/artifact/seed.ts';
import type { CheckDiagnostic } from '@norbital-ai/host-api';
import { authorErrors, ToolFailure, type Log } from './build.ts';

/** The host and the signing key its operations verify: `scope` is the host's deployment environment. */
export type SeedTarget = {
	readonly url: string;
	readonly tenant: string;
	readonly secret: string;
	readonly scope: string;
};
const Answer = Schema.Union([
	Schema.Struct({ value: Schema.Unknown }),
	Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) })
]);

const call = (target: SeedTarget, op: string, input: object) =>
	Effect.gen(function* () {
		const body = JSON.stringify(input);
		const now = Date.now();
		const response = yield* Effect.tryPromise({
			try: (signal) =>
				fetch(`${target.url}/__colony/ops`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						...sign_op(target, new URL(target.url).host, op, body, now)
					},
					body,
					signal
				}),
			catch: (cause) => new ToolFailure({ message: `${op}: ${String(cause)}`, cause })
		});
		const text = yield* Effect.tryPromise({
			try: () => response.text(),
			catch: (cause) => new ToolFailure({ message: `${op}: ${String(cause)}`, cause })
		});
		const answer = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Answer))(text).pipe(
			Effect.mapError(
				() => new ToolFailure({ message: `${op}: HTTP ${response.status} ${text.slice(0, 300)}` })
			)
		);
		if ('error' in answer)
			return yield* new ToolFailure({
				message: `${op} was refused: ${answer.error.code}: ${answer.error.message}`
			});
		return answer.value;
	});

/** The rehearsal's file store: it reads each asset and keeps no bytes; the scratch database is all it restores into. */
const scratchFiles: Files['Service'] = {
	put: (bytes, meta) =>
		Effect.sync(() => {
			const sha256 = createHash('sha256').update(bytes).digest('hex');
			return { key: sha256, bytes: bytes.byteLength, sha256, mime: meta.mime };
		}),
	get: () => Effect.die('the seed rehearsal keeps no files'),
	url: () => Effect.die('the seed rehearsal keeps no files'),
	remove: () => Effect.void,
	download: () => Effect.die('the seed rehearsal downloads nothing')
};

/**
 * `seeding` restored into a scratch database of `manifest`'s schema, the host's pack load (rows, identities, `start`,
 * and each `{ asset }` file value as the `sys_file` reference the host stores).
 */
const rehearse = (manifest: EngineManifest, seeding: Seeding) =>
	Effect.gen(function* () {
		const db = yield* TenantDb;
		const now = new Date(yield* Clock.currentTimeMillis).toISOString();
		const source = memory_source('bank', seeding.rows, seeding.start, seeding.assets, (path) =>
			Effect.sync(() => seeding.bytes(path))
		);
		yield* drain((yield* pack_asset_loader(db, manifest, source, scratchFiles, now)).step);
	}).pipe(
		Effect.provide(TestDb.layer(manifest)),
		Effect.provide(NodeServices.layer),
		Effect.mapError(
			(cause) => new ToolFailure({ message: `the seed does not restore: ${cause.message}`, cause })
		)
	);

/** Sends `seeding` to `target` once it restores: its assets first, then the rows the host restores into the environment. */
export const pushSeed = Effect.fn('bolt.pushSeed')(function* (
	manifest: EngineManifest,
	seeding: Seeding,
	target: SeedTarget
) {
	yield* rehearse(manifest, seeding);
	yield* Effect.forEach(
		seeding.assets,
		(asset) =>
			call(target, 'seed.asset', {
				tenant: target.tenant,
				sha256: asset.sha256,
				bytes: Buffer.from(seeding.bytes(asset.path)).toString('base64')
			}),
		{ concurrency: 4, discard: true }
	);
	return yield* call(target, 'seed', {
		tenant: target.tenant,
		rows: seeding.rows,
		start: seeding.start,
		assets: seeding.assets
	});
});

/** `bolt seed`: without `target`, the bank's rows are read, decoded and restored into a scratch database only. */
export const seedWorkspace = Effect.fn('bolt.seedWorkspace')(function* (
	dir: string,
	bank: string,
	target: SeedTarget | undefined,
	log: Log
) {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(dir);
	const compiled = yield* compile(root);
	if (compiled.errors.length > 0 || compiled.manifest === undefined)
		return yield* Effect.fail(authorErrors(compiled.errors));
	const errors: CheckDiagnostic[] = [];
	const seeding = yield* seedRows(
		root,
		compiled.manifest,
		yield* fs.realPath(bank),
		`${root}/.norbital/cache`,
		errors
	);
	if (seeding === null)
		return yield* Effect.sync(() => log('the seeder names no bank tree: nothing to seed'));
	if (seeding === undefined)
		return yield* Effect.fail(authorErrors(errors, `${errors.length} seed errors`));
	const counted = Object.values(seeding.rows).reduce((n, rows) => n + rows.length, 0);
	const summary = `${counted} rows of ${Object.keys(seeding.rows).length} models and ${seeding.assets.length} assets from '${seeding.tree}'`;
	if (target === undefined)
		return yield* rehearse(compiled.manifest, seeding).pipe(
			Effect.andThen(Effect.sync(() => log(`${summary}: decoded and restored into a scratch database`)))
		);
	yield* pushSeed(compiled.manifest, seeding, target);
	log(`${summary}: loaded into ${target.tenant}`);
});
