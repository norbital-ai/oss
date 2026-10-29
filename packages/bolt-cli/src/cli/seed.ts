/// <reference types="node" />
// `bolt seed` (docs/seeding.md): a bank tree's private rows, read into memory through `seed/+seeder.ts`, decoded, and
// sent to one environment of a host as signed operations: each asset (`seed.asset`, kept once by its digest), then
// the rows (`seed`), which the host restores over a reset of the environment. Nothing is written to either disk.
import { Effect, FileSystem, Schema } from 'effect';
import { signOp } from '@norbital-ai/std/host-op';
import { compile } from '../compiler/check/index.ts';
import { seedRows, type Seeding } from '../compiler/artifact/seed.ts';
import type { CheckDiagnostic } from '@norbital-ai/bolt/tooling';
import { AuthorErrors, ToolFailure, type Log } from './build.ts';

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
						...signOp(target, new URL(target.url).host, op, body, now)
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

/** Sends `seeding` to `target`: its assets first, then the rows the host restores into the environment. */
export const pushSeed = Effect.fn('bolt.pushSeed')(function* (
	seeding: Seeding,
	target: SeedTarget
) {
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

/** `bolt seed`: without `target`, the bank's rows are read and decoded only. */
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
		return yield* new AuthorErrors({
			errors: compiled.errors,
			message: `${compiled.errors.length} errors`
		});
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
		return yield* new AuthorErrors({ errors, message: `${errors.length} seed errors` });
	const counted = Object.values(seeding.rows).reduce((n, rows) => n + rows.length, 0);
	const summary = `${counted} rows of ${Object.keys(seeding.rows).length} models and ${seeding.assets.length} assets from '${seeding.tree}'`;
	if (target === undefined) return yield* Effect.sync(() => log(`${summary}: decoded`));
	yield* pushSeed(seeding, target);
	log(`${summary}: loaded into ${target.tenant}`);
});
