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
	IsolatesLive,
	type GuestOptions,
	type GuestProgram
} from '../../src/engine/guest/runner.ts';
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
	collections = resolve(root, 'src/decl/collection.ts');
class GuestFixtureFailed extends Schema.TaggedError<GuestFixtureFailed>()('GuestFixtureFailed', {
	message: Schema.String
}) {}
const entry = (sourceFile: string) => `import '${INSTALL}';
import value from ${JSON.stringify(sourceFile)};
import { attached } from ${JSON.stringify(collections)};
const gen = (fn, at) => typeof fn === 'function' && Object.prototype.toString.call(fn) === '[object GeneratorFunction]' ? attached(fn, at) : fn;
for (const c of Object.values(value.collection ?? {})) {
	if (!c?.bodies) continue;
	for (const key of ['project','transform']) c.bodies[key] = gen(c.bodies[key], 1);
	for (const part of ['queries','actions']) for (const [name, body] of Object.entries(c.bodies[part] ?? {})) c.bodies[part][name] = gen(body,1);
}
for (const a of Object.values(value.automation ?? {})) a.body = gen(a.body,1);
for (const page of Object.values(value.page ?? {})) page.body = gen(page.body,1);
for (const p of Object.values(value.pipeline ?? {})) for (const key of ['known','check','template']) if(p.spec?.import?.[key]) p.spec.import[key] = gen(p.spec.import[key],0);
for (const i of Object.values(value.integration_definition ?? value.integration ?? {})) {
	if (!i?.bodies) continue;
	i.bodies.test = gen(i.bodies.test,0); i.bodies.receive = gen(i.bodies.receive,-1); i.bodies.send = gen(i.bodies.send,1);
	for (const feed of Object.values(i.bodies.feeds ?? {})) for (const key of ['read','map']) feed[key] = gen(feed[key],1);
	for (const out of Object.values(i.bodies.outbound ?? {})) out.run = gen(out.run,1);
}
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
						alias: [{ find: /^@norbital-ai\/bolt$/, replacement: resolve(root, 'src/index.ts') }]
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

/** Each snippet compiles once, even when its workspace is independently scoped by several tests. */
export const program = (source: string): Effect.Effect<GuestProgram> => {
	let cached: Effect.Effect<GuestProgram> | undefined;
	return Effect.gen(function* () {
		cached ??= yield* Effect.cached(compileProgram(source));
		return yield* cached;
	});
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
				create: { input: { columns: [] } },
				actions: {
					first: { description: 'first', input: {} },
					second: { description: 'second', input: {} }
				}
			},
			jobs: { read: { fields: 'all' }, update: { input: { columns: [] } } }
		},
		policies: {},
		automations: {
			a: { description: 'a', runAs: 'trigger' },
			b: { description: 'b', runAs: 'trigger' }
		},
		integrations: {},
		pipelines: {},
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
	isolates = IsolatesLive
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
					transforms: new Set<string>(),
					projections: new Set<string>(),
					start: [],
					secretsKey: Option.none()
				}),
				Layer.succeed(Telemetry, {
					open: events ?? (() => Effect.succeed({ emit: () => Effect.void }))
				})
			)
		)
	);
