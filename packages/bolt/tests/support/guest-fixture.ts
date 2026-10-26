// Guest sources use the compiler's Vite bundler and the same attachment edge as authored workspaces.
import { build } from 'vite';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Effect, Layer, Option, Result, Schema } from 'effect';
import { decodeManifest } from '../../src/engine/manifest.ts';
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = '\0bolt:fixture-entry',
	INSTALL = '\0bolt:fixture-install';
const edge = resolve(root, 'src/decl/runtime/guest.ts'),
	bodies = resolve(root, 'src/decl/body.ts'),
	policy = resolve(root, 'src/decl/access/policy.ts');
class GuestFixtureFailed extends Schema.TaggedError<GuestFixtureFailed>()('GuestFixtureFailed', {
	message: Schema.String
}) {}
const entry = (sourceFile: string) => `import '${INSTALL}';
import value from ${JSON.stringify(sourceFile)};
import { attached } from ${JSON.stringify(bodies)};
import { approvalFlow, snapshotOf } from ${JSON.stringify(policy)};
const gen = (fn, at) => typeof fn === 'function' && Object.prototype.toString.call(fn) === '[object GeneratorFunction]' ? attached(fn, at) : fn;
for (const c of Object.values(value.collection ?? {})) {
	if (!c?.bodies) continue;
	for (const key of ['create','update','delete','notify']) c.bodies[key] = gen(c.bodies[key], 1);
	for (const [name, body] of Object.entries(c.bodies.queries ?? {})) c.bodies.queries[name] = gen(body,1);
	for (const sync of Object.values(c.bodies.syncs ?? {})) {
		for (const key of ['read','write']) sync[key] = gen(sync[key],1);
		for (const [type, body] of Object.entries(sync.parse ?? {})) sync.parse[type] = gen(body,1);
	}
}
for (const p of Object.values(value.policy ?? {})) for (const grant of Object.values(p.grants ?? {})) {
	for (const op of ['create','update','delete']) if (typeof grant[op]?.approval === 'function') {
		const approve = grant[op].approval;
		grant[op].approval = (write) => snapshotOf(approve(write, approvalFlow()));
	}
}
for (const a of Object.values(value.automation ?? {})) a.body = gen(a.body,1);
for (const page of Object.values(value.page ?? {})) page.body = gen(page.body,1);
for (const i of Object.values(value.integration_definition ?? {})) if(i?.bodies) i.bodies.test = gen(i.bodies.test,0);
export default value;`;
const fixtureFailure = (error: unknown) =>
	new GuestFixtureFailed({ message: error instanceof Error ? error.message : String(error) });
const io = <A>(read: () => Promise<A>): Effect.Effect<A, GuestFixtureFailed> =>
	Effect.tryPromise({ try: read, catch: fixtureFailure });
const compileProgram = (source: string): Effect.Effect<GuestProgram> =>
	Effect.scoped(
		Effect.gen(function* () {
			const directory = yield* Effect.acquireRelease(
				io(() => mkdtemp(join(tmpdir(), 'norbital-guest-fixture-'))),
				(directory) => io(() => rm(directory, { recursive: true, force: true })).pipe(Effect.orDie)
			);
			// A real module keeps authored source mappings through Rolldown.
			const sourceFile = join(directory, 'fixture-source.mjs');
			const mappedSource = `/${basename(directory)}/fixture-source.mjs`;
			yield* io(() =>
				symlink(resolve(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
			);
			yield* io(() => writeFile(sourceFile, source, 'utf8'));
			const built = yield* io(() =>
				build({
					root,
					configFile: false,
					logLevel: 'silent',
					resolve: {
						alias: [
							{ find: /^@norbital-ai\/bolt$/, replacement: resolve(root, 'src/index.ts') },
							{
								find: /^@norbital-ai\/bolt\/errors$/,
								replacement: resolve(root, 'src/decl/errors.ts')
							}
						]
					},
					plugins: [
						{
							name: 'bolt:guest-fixture',
							resolveId: (id) => (id === ENTRY || id === INSTALL ? id : undefined),
							load: (id) =>
								id === ENTRY
									? entry(sourceFile)
									: id === INSTALL
										? `import { install } from ${JSON.stringify(edge)}; install();`
										: undefined
						}
					],
					build: {
						write: false,
						minify: 'oxc',
						sourcemap: true,
						rolldownOptions: {
							input: ENTRY,
							preserveEntrySignatures: 'strict',
							output: { format: 'es', codeSplitting: false }
						}
					}
				})
			);
			const outputs = Array.isArray(built) ? built : [built];
			for (const output of outputs)
				if ('output' in output)
					for (const chunk of output.output)
						if (chunk.type === 'chunk' && chunk.isEntry)
							return {
								source: chunk.code,
								...(chunk.map === null
									? {}
									: {
											sourceMap: JSON.stringify({
												...chunk.map,
												sources: chunk.map.sources.map((mapped) =>
													mapped === sourceFile || mapped.endsWith(mappedSource)
														? 'guest.mjs'
														: mapped
												)
											})
										})
							};
			return yield* Effect.fail(
				new GuestFixtureFailed({ message: 'the fixture bundler returned no guest entry' })
			);
		})
	).pipe(Effect.orDie);

const programs = new Map<string, Effect.Effect<GuestProgram>>();
/** Only compiled source strings are shared within a test file; databases and guest runtimes remain scoped. */
export const program = (source: string): Effect.Effect<GuestProgram> => {
	const existing = programs.get(source);
	if (existing !== undefined) return existing;
	let cached: Effect.Effect<GuestProgram> | undefined;
	const compiled: Effect.Effect<GuestProgram> = Effect.gen(function* () {
		const prepared =
			cached ??
			(yield* Effect.cached(
				compileProgram(source).pipe(Effect.map((value) => Object.freeze(value)))
			));
		cached = prepared;
		return yield* prepared;
	});
	programs.set(source, compiled);
	return compiled;
};

export const fixtureManifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {},
		relationships: {},
		collections: {
			a: { read: { fields: 'all' }, create: { input: { columns: [] } } },
			b: { read: { fields: 'all' }, update: { input: { columns: [] } } },
			t: {
				read: { fields: 'all' },
				create: { input: { columns: [] } }
			},
			jobs: { read: { fields: 'all' }, update: { input: { columns: [] } } }
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
