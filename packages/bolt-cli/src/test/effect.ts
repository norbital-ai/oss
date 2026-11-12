// The workspace kit is a scoped Effect layer; its callers use the same routes as a real host.
import * as EffectVitest from '@effect/vitest';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Context, Effect, FileSystem, Layer, Option, Schema, SchemaGetter } from 'effect';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
	apply_migrations,
	decode_manifest,
	read_applied,
	read_migrations,
	read_pack,
	TenantDb,
	type EngineManifest,
	type GuestProgram,
	type MigrationBundle,
	type TenantDbShape
} from '@norbital-ai/bolt/engine';
import {
	Diagnostic,
	fingerprint,
	KitInvalid,
	schema_slice,
	TestEngine,
	test_engine,
	type CheckDiagnostic
} from '@norbital-ai/bolt/tooling';
import type { Artifact } from '@norbital-ai/bolt/artifact';
import { node_guests } from '../guests.ts';
import { memory_audit } from './audit.ts';
import { CHECKPOINTS, inputs, keep, prune, tree_hash } from './checkpoint.ts';
import { TestDb } from './database.ts';

/**
 * Effect-aware Vitest helpers: `it.effect` scopes each test, `layer` shares a scoped service layer across a suite,
 * `describe` groups scenarios, and `expect` asserts their values and outcomes.
 */
export const it = EffectVitest.it;
/** Share one scoped Effect service layer across the tests in a suite. */
export const layer = EffectVitest.layer;
/** Group related workspace test scenarios using Vitest's suite lifecycle. */
export const describe = EffectVitest.describe;
/** Assert workspace values and typed operation outcomes with Vitest's matchers. */
export const expect = EffectVitest.expect;
export { KitInvalid };
/** A scoped workspace's test controls: create callers, inspect native rows and port observations, advance its clock, run due work, and exercise real HTTP and integration entry points. */
export interface Kit extends EngineKit {}
type EngineKit = TestEngine['Service'];
/**
 * Reads, writes, approval decisions, uploads and automation starts through the real host routes under one authority, with
 * native decoded values and typed failures.
 */
export type Caller = Effect.Success<ReturnType<Kit['as']>>;
/** A manifest-dependent query's decoded pages or aggregates; dynamic field values retain their native values. */
export type NativeReadAnswer = Effect.Success<ReturnType<Caller['query']>>;
/** A native map-write outcome, with each import result decoded using its actual model. */
export type NativeActAnswer = Effect.Success<ReturnType<Caller['act']>>;
type EngineOptions<P extends TestPorts> = Parameters<typeof test_engine<P>>[0];
/** Host port service keys a test may replace with native Layers, including file storage, conversion, web, geography, transport, AI, outbound HTTP, images and MCP. */
export type TestPorts = Layer.Success<NonNullable<Parameters<typeof test_engine>[0]['ports']>>;
/** Failures while acquiring or operating a test workspace: invalid fixtures, engine faults, port failures and platform I/O errors. */
type KitFailure = Layer.Error<ReturnType<typeof test_engine>>;
/** The engine, database, host, shell and port services made available alongside `TestWorkspace` by its layer. */
export type WorkspaceServices = Exclude<Layer.Success<ReturnType<typeof test_engine>>, TestEngine>;
/** AI playback configuration: response cassettes and an optional System 1 responder. */
export type CassetteOptions = NonNullable<NonNullable<EngineOptions<never>['fakes']>['ai']>;
type Pack = Effect.Success<ReturnType<NonNullable<EngineOptions<never>['pack']>>>;
/**
 * Workspace fixture and host configuration: use a verified release, check authored source, or supply a manifest/guest (with
 * `transforms`, the write callbacks it carries per verb: `'<model>.create'`, `'<model>.update'`); choose
 * seed data, control time, and native ports. `seed` defaults to the template's `test` pack when `root` has `seed/test/`,
 * else none; rows here replace it.
 */
export type TestOptions<P extends TestPorts = never> = Pick<
	EngineOptions<P>,
	'seed' | 'now' | 'secrets_key' | 'ports' | 'fakes' | 'links' | 'host'
> & {
	pack?: Pack;
	/** The workspace guest CPU budget; the kit default is the host's 3000 ms. */
	guest_cpu_ms?: number;
	/** Optional meter for each guest run's CPU, for profiling a workspace. */
	guest_meter?: (session: string, nanos: bigint) => void;
	db?: Layer.Layer<TenantDb, KitFailure>;
} & (
		| {
				/** A release verified by read_artifact; public HTTP requests execute its isolated server programs. */
				artifact: Artifact;
				root?: never;
				manifest?: never;
				guest?: never;
				transforms?: never;
		  }
		| {
				artifact?: never;
				root?: string;
				manifest?: EngineManifest;
				guest?: GuestProgram;
				transforms?: Iterable<string>;
		  }
	);
/** A queued automation's actual native receipt, suitable as a `run` result decoder. */
export const JobResult = TestEngine.JobResult;
export type JobResult = typeof JobResult.Type;
/** A native query row's fixed metadata; its manifest-dependent fields retain their decoded values. */
export const NativeReadRow = TestEngine.NativeReadRow;
export type NativeReadRow = typeof NativeReadRow.Type;
/** A deterministic, zero-cost System 1 responder for tests: prefer the `respond` choice, otherwise the first choice, and return zero scores. */
export const respond_system_1 = TestEngine.respond_system_1;

const invalid = (e: unknown) =>
	new KitInvalid({ message: e instanceof Error ? e.message : String(e) });
const node = NodeChildProcessSpawner.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer))
);
type CheckResult = import('../compiler/check/index.ts').CheckResult;
const compiled = new Map<string, Effect.Effect<CheckResult, KitInvalid>>();
// Keep the cache's existing permissive base64 decoder.
const CachedGuest = Schema.Struct({
	source: Schema.String,
	source_map: Schema.optionalKey(Schema.String),
	assets: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.String.pipe(
				Schema.decodeTo<typeof Schema.Uint8Array, typeof Schema.String>(Schema.Uint8Array, {
					decode: SchemaGetter.transform((text) => new Uint8Array(Buffer.from(text, 'base64'))),
					encode: SchemaGetter.transform((bytes) => Buffer.from(bytes).toString('base64'))
				})
			)
		)
	)
});
/** A check result as one run's processes share it: the guest's `?bytes` assets as base64, the manifest as its JSON. */
const RunChecked = Schema.Struct({
	stages: Schema.Array(
		Schema.Literals([
			'discover',
			'names',
			'bundle',
			'evaluate',
			'manifest',
			'seed',
			'schema',
			'rules'
		])
	),
	errors: Schema.Array(Diagnostic),
	manifest: Schema.optionalKey(Schema.Json),
	guest: Schema.optionalKey(CachedGuest),
	transforms: Schema.Array(Schema.String),
	seed: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, Schema.Json)))
	)
});
const toRun = Effect.fnUntraced(function* (c: CheckResult) {
	const run: typeof RunChecked.Encoded = {
		stages: c.stages,
		errors: c.errors,
		transforms: c.transforms,
		...(c.manifest === undefined
			? {}
			: {
					manifest: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
						JSON.stringify(c.manifest)
					)
				}),
		...(c.seed === undefined ? {} : { seed: c.seed }),
		...(c.guest === undefined ? {} : { guest: yield* Schema.encodeEffect(CachedGuest)(c.guest) })
	};
	return run;
});
const fromRun = (r: typeof RunChecked.Type) =>
	Effect.gen(function* () {
		const manifest =
			r.manifest === undefined
				? undefined
				: yield* Effect.fromResult(decode_manifest(r.manifest)).pipe(Effect.mapError(invalid));
		const result: CheckResult = {
			stages: [...r.stages],
			errors: r.errors.map((e) => ({ ...e })),
			transforms: [...r.transforms],
			...(manifest === undefined ? {} : { manifest }),
			...(r.seed === undefined ? {} : { seed: r.seed }),
			...(r.guest === undefined ? {} : { guest: { ...r.guest } })
		};
		return result;
	});
/**
 * Checkpoints kept per kind on this machine: more than one run's workspaces (a whole realm run checks about 15), so a
 * run never evicts its own; a checked workspace is about 6 MiB.
 */
const KEPT_CHECKS = 64,
	KEPT_SEEDS = 128;
/** A workspace's checkpoint key: its source and the Bolt modules the checkpoint is built through. */
const sourceKey = (root: string, modules: Effect.Effect<string>) =>
	Effect.gen(function* () {
		return createHash('sha256')
			.update(`${yield* modules}\0${yield* tree_hash(root)}`)
			.digest('hex');
	}).pipe(Effect.mapError(invalid));
/** A workspace's check, from its checkpoint when its source and the compiler are unchanged, else checked once and kept. */
const storedCheck = (root: string, compute: Effect.Effect<CheckResult, KitInvalid>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const dir = join(CHECKPOINTS, 'workspaces');
		const file = join(dir, `${yield* sourceKey(root, inputs.check)}.json`);
		const kept = yield* fs
			.readFileString(file)
			.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RunChecked))),
				Effect.option
			);
		if (Option.isSome(kept)) return yield* fromRun(kept.value);
		return yield* Effect.tap(compute, (result) =>
			toRun(result).pipe(
				Effect.flatMap((run) => keep(file, JSON.stringify(run))),
				Effect.andThen(prune(dir, KEPT_CHECKS))
			)
		);
	}).pipe(Effect.provide(node), Effect.mapError(invalid));
const checked = (root: string) =>
	Effect.gen(function* () {
		let cached = compiled.get(root);
		if (cached === undefined) {
			const compiler = yield* Effect.tryPromise({
				try: () => import('../compiler/check/index.ts'),
				catch: invalid
			});
			cached = yield* Effect.cached(
				storedCheck(
					root,
					compiler
						.check(root, { timing: false })
						.pipe(Effect.provide(node), Effect.mapError(invalid))
				)
			);
			compiled.set(root, cached);
		}
		return yield* cached;
	});
/** Check a workspace root and return its diagnostics, manifest and guest program; compiler loading and tool failures become `KitInvalid`. */
export const check = (root: string) => checked(root);
/** The template's `test` pack (`seed/test/`), built once per source beside its checkpoint; the first rename wins. */
const readTestPack = (root: string, manifest: EngineManifest) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const shared = join(CHECKPOINTS, 'seeds', yield* sourceKey(root, inputs.seed));
		if (!(yield* fs.exists(join(shared, 'test', 'pack.json'))))
			yield* Effect.gen(function* () {
				const artifact = yield* Effect.tryPromise({
					try: () => import('../compiler/artifact/seed.ts'),
					catch: invalid
				});
				const errors: CheckDiagnostic[] = [];
				const temporary = `${shared}.${randomUUID()}`;
				yield* artifact.buildTestPack(root, manifest, temporary, errors);
				if (errors.length > 0)
					return yield* Effect.fail(
						new KitInvalid({
							message: `TestWorkspace: the test pack failed:\n${errors.map((d) => `  ${d.code} ${d.message}`).join('\n')}`
						})
					);
				yield* fs.makeDirectory(dirname(shared), { recursive: true });
				yield* fs
					.rename(temporary, shared)
					.pipe(Effect.catch(() => fs.remove(temporary, { recursive: true, force: true })));
				yield* prune(dirname(shared), KEPT_SEEDS);
			});
		return yield* read_pack(join(shared, 'test'));
	}).pipe(Effect.provide(node), Effect.mapError(invalid));
const packs = new Map<string, Effect.Effect<Pack, KitInvalid>>();
/** The test pack, read once per process (hashing the source tree and decoding every row are not per-test work). */
const testPack = (root: string, manifest: EngineManifest) =>
	Effect.gen(function* () {
		let cached = packs.get(root);
		if (cached === undefined) {
			cached = yield* Effect.cached(readTestPack(root, manifest));
			packs.set(root, cached);
		}
		return yield* cached;
	});

/** An injected database at the workspace's schema: Identity loads its keys from native tables. */
const migrated = (db: TenantDbShape, m: EngineManifest, migrations: MigrationBundle | undefined) =>
	Effect.gen(function* () {
		const applied = yield* read_applied(db);
		if (applied !== null && applied.fingerprint === fingerprint(schema_slice(m))) return;
		if (migrations === undefined) yield* TestDb.migrate(db, m, { accept: true });
		else yield* apply_migrations(db, m, migrations);
	});

/** A native test workspace service; its layer owns database and engine resources in scope and exposes the same host routes used by deployed workspaces. */
export class TestWorkspace extends Context.Service<TestWorkspace, Kit>()(
	'@norbital-ai/bolt-cli/test/TestWorkspace'
) {
	static readonly layer = <P extends TestPorts>(
		options: TestOptions<P>
	): Layer.Layer<TestWorkspace | WorkspaceServices, KitFailure> =>
		Layer.effectContext(
			Effect.gen(function* () {
				const { root, db: injected, pack, guest_cpu_ms, guest_meter, ...engine } = options;
				let { manifest, guest, transforms } = options;
				const artifact = options.artifact;
				let migrations = artifact?.migrations;
				if (artifact !== undefined) ({ manifest, guest } = artifact);
				// a template's tests seed from its own `test` pack (`seed/test/`) unless they pass rows or 'none'; the public
				// `base` and the bank's `sample` are product seeds, never test fixtures
				const testRoot =
					options.seed === undefined &&
					root !== undefined &&
					(yield* FileSystem.FileSystem.pipe(
						Effect.flatMap((fs) => fs.exists(join(root, 'seed', 'test'))),
						Effect.provide(node),
						Effect.mapError(invalid)
					))
						? root
						: undefined;
				if (root !== undefined) {
					const built = yield* checked(root);
					if (built.errors.length > 0 || built.manifest === undefined)
						return yield* Effect.fail(
							new KitInvalid({
								message: `bolt check failed:\n${built.errors.map((d) => `  ${d.code} ${d.message}`).join('\n')}`
							})
						);
					({ manifest, guest, transforms } = built);
					const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(node));
					const directory = join(root, 'migrations');
					if (yield* fs.exists(join(directory, 'snapshot.json')).pipe(Effect.mapError(invalid)))
						migrations = yield* read_migrations(directory).pipe(
							Effect.provide(node),
							Effect.mapError(invalid)
						);
				}
				if (manifest === undefined)
					return yield* Effect.fail(
						new KitInvalid({ message: 'TestWorkspace takes a root or a manifest' })
					);
				const context = yield* Layer.build(
					test_engine({
						...engine,
						manifest,
						guest,
						transforms,
						artifact,
						db: (m) =>
							injected === undefined
								? TestDb.layer(m, migrations)
								: Layer.effect(
										TenantDb,
										Effect.gen(function* () {
											const db = yield* TenantDb;
											yield* migrated(db, m, migrations);
											return db;
										})
									).pipe(Layer.provide(injected)),
						// the kit's own runner: guest code runs in this process's `node:vm` contexts
						guests: node_guests({
							...(guest_cpu_ms == null ? {} : { cpu_ms: guest_cpu_ms }),
							...(guest_meter == null ? {} : { meter: guest_meter })
						}),
						audit: memory_audit(),
						pack:
							pack !== undefined
								? () => Effect.succeed(pack)
								: testRoot === undefined
									? undefined
									: (m) => testPack(testRoot, m)
					})
				);
				return Context.add(context, TestWorkspace, Context.get(context, TestEngine));
			})
		);
}
