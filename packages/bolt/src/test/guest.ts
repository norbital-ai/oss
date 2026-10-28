// Guest programs for Bolt's own tests: a source string bundled by the compiler's Vite through the same attachment edge as
// authored workspaces, kept as a checkpoint so a test never builds.
import { build } from 'vite';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Effect, Option, Schema } from 'effect';
import type { GuestProgram } from '../engine/guest/runner.ts';
import { CHECKPOINTS, inputs, keep, prune } from './checkpoint.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = '\0bolt:fixture-entry',
	INSTALL = '\0bolt:fixture-install';
const edge = resolve(root, 'src/decl/runtime/guest.ts'),
	bodies = resolve(root, 'src/decl/body.ts');
class GuestFixtureFailed extends Schema.TaggedError<GuestFixtureFailed>()('GuestFixtureFailed', {
	message: Schema.String
}) {}
const entry = (sourceFile: string) => `import '${INSTALL}';
import value from ${JSON.stringify(sourceFile)};
import { attached } from ${JSON.stringify(bodies)};
const gen = (fn, at) => typeof fn === 'function' && Object.prototype.toString.call(fn) === '[object GeneratorFunction]' ? attached(fn, at) : fn;
for (const c of Object.values(value.model ?? {})) {
	if (!c?.bodies) continue;
	for (const key of ['create','update','delete','notify']) c.bodies[key] = gen(c.bodies[key], 1);
	for (const sync of Object.values(c.bodies.syncs ?? {})) {
		for (const key of ['read','write']) sync[key] = gen(sync[key],1);
		for (const [type, body] of Object.entries(sync.parse ?? {})) sync.parse[type] = gen(body,1);
	}
}
// a policy's write checks, as the compiler's \`__checks\` attaches them (\`policy.<p>.grants.<model>.<op>.check\`)
for (const p of Object.values(value.policy ?? {})) for (const grant of Object.values(p.grants ?? {}))
	for (const op of ['create','update','delete']) if (grant?.[op]?.check) grant[op].check = gen(grant[op].check, 1);
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

const Compiled = Schema.Struct({
	source: Schema.String,
	sourceMap: Schema.optionalKey(Schema.String)
});
/** Compiled guests kept on this machine: more than every suite's fixtures, so a run never evicts its own. */
const KEPT_GUESTS = 2048;
const GUESTS = join(CHECKPOINTS, 'guests');
/** A compiled guest from its checkpoint (by the source and the Bolt it bundles), else compiled once and kept. */
const checkpointed = (source: string): Effect.Effect<GuestProgram> =>
	Effect.gen(function* () {
		const key = createHash('sha256')
			.update(`${yield* inputs.guest}\0${source}`)
			.digest('hex');
		const file = join(GUESTS, `${key}.json`);
		const kept = yield* io(() => readFile(file, 'utf8')).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Compiled))),
			Effect.option
		);
		if (Option.isSome(kept)) return kept.value;
		return yield* Effect.tap(compileProgram(source), (compiled) =>
			Effect.andThen(keep(file, JSON.stringify(compiled)), prune(GUESTS, KEPT_GUESTS))
		);
	}).pipe(Effect.orDie);

const programs = new Map<string, Effect.Effect<GuestProgram>>();
/** A guest program for a source string, compiled once per source and Bolt across runs; only the program is shared. */
export const program = (source: string): Effect.Effect<GuestProgram> => {
	const existing = programs.get(source);
	if (existing !== undefined) return existing;
	let cached: Effect.Effect<GuestProgram> | undefined;
	const compiled: Effect.Effect<GuestProgram> = Effect.gen(function* () {
		const prepared =
			cached ??
			(yield* Effect.cached(
				checkpointed(source).pipe(Effect.map((value) => Object.freeze(value)))
			));
		cached = prepared;
		return yield* prepared;
	});
	programs.set(source, compiled);
	return compiled;
};
