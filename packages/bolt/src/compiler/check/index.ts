/// <reference types="node" />
// `bolt check` (rule 7): discover → bundle → evaluate → manifest → names → seed decode → schema → build checks, every
// error of every stage in one run (a stage whose input failed is skipped, the others still run). Its first stages are
// `bolt sync`: the names index is printed from the evaluated declarations, and an evaluation that fails keeps the last
// good one. Workspace diagnostics use the TypeScript language service; deeper audits run on request. Declarations are
// evaluated in isolated-vm (rule 2) with a frozen clock and seeded `Math.random`, twice, and both manifest hashes must
// match; the guest program obeys rule 6's walls.
import { sha256Hex } from '@norbital-ai/store';
import { builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Effect, FileSystem, Option, Path, Result, Schema } from 'effect';
import ivm from 'isolated-vm';
import { build, type Rolldown } from 'vite';
import { minify, type MinifyOptions } from 'terser';
import type { RowData } from '../../engine/contracts.ts';
import { decodeManifest, projectManifest, type EngineManifest } from '../../engine/manifest.ts';
import { PRELUDE } from '../../engine/guest/prelude.ts';
import type { GuestProgram } from '../../engine/guest/runner.ts';
import { assetHook, digest, randomStream } from '../../node/guest-isolates.ts';
import { plan } from '../../engine/schema/plan.ts';
import { decodeSeed, type SeedPack } from '../../engine/write/seed.ts';
import { discover, type Discovered } from '../discover.ts';
import { load, manifestErrors } from '../load.ts';
import { namesIndex, writeNames, writeTypeSetup } from '../names.ts';
import { checkRules, sourceRules } from './rules.ts';
import { prepareMigrations } from '../migrations.ts';
import type { CheckDiagnostic } from '../../protocol/diagnostic.ts';
export type { CheckDiagnostic } from '../../protocol/diagnostic.ts';

export type Stage =
	'discover' | 'bundle' | 'evaluate' | 'manifest' | 'names' | 'seed' | 'schema' | 'rules';
export type CheckResult = {
	/** The stages that ran, in order (test `compiler/check-order`). */
	stages: Stage[];
	errors: CheckDiagnostic[];
	manifest?: EngineManifest;
	guest?: GuestProgram;
	/** The write callbacks the models declare, per verb: `'<model>.create'`, `'<model>.update'`, `'<model>.delete'`. */
	transforms: string[];
	seed?: SeedPack;
};

const GUEST_BYTES = 8 * 1024 * 1024,
	EVAL_CPU_MS = 100,
	FROZEN = Date.UTC(2000, 0, 1);
// src or the published build; a path join, since a DOM test environment's transform rewrites `new URL(…, import.meta.url)` to an asset
const BOLT = join(
	dirname(fileURLToPath(import.meta.url)),
	'../..',
	`index${extname(fileURLToPath(import.meta.url))}`
);
const ENTRY = 'virtual:bolt-guest',
	BYTES = '?bytes',
	BYTES_ID = '\0bolt-bytes:';
// The guest edge (D8): a module under root with a generator body imports and installs it first, so `attached` wraps the
// body; a bundle without one (`blank`) carries neither the edge nor Effect.
const EDGE = `import { install as __boltEdge } from ${JSON.stringify(join(dirname(BOLT), 'decl', 'runtime', `guest${extname(BOLT)}`))}; __boltEdge();`;
const SCRIPT = /\.[cm]?[jt]sx?$/,
	GENERATOR = /\bfunction\s*\*|[{,]\s*\*\s*[\w$]+\s*\(/;
const NODE = new Set([...builtinModules, ...builtinModules.map((b) => `node:${b}`)]);
export class BundleError extends Schema.TaggedError<BundleError>()('BundleError', {
	cause: Schema.Defect()
}) {}
export class EvalError extends Schema.TaggedError<EvalError>()('EvalError', {
	cause: Schema.Defect()
}) {}
const Minified = Schema.Struct({ code: Schema.String, map: Schema.String });
const Evaluated = Schema.Struct({
	roles: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
	bodies: Schema.Struct({
		transforms: Schema.Array(Schema.String),
		automations: Schema.Array(Schema.String),
		models: Schema.Array(Schema.String)
	})
});

/**
 * `bolt sync`'s stages, the front of every check: discover → bundle → evaluate → manifest → names. The type setup is
 * written first (the workspace tsconfig extends it); the names index is printed from the evaluated declarations, and an
 * evaluation or a model literal that fails keeps the last good index, so no body loses its types to a broken save.
 */
const front = Effect.fn('bolt.front')(function* (
	root: string,
	stage: (s: Stage) => void,
	errors: CheckDiagnostic[],
	bolt: string | undefined
) {
	stage('discover');
	const { files, errors: layout } = yield* discover(root);
	errors.push(...layout);
	yield* writeTypeSetup(root);

	stage('bundle');
	const code = files.filter((f) => f.path.endsWith('.ts'));
	const guest = yield* bundle(root, code, errors);
	if (guest === undefined) return undefined;

	stage('evaluate');
	const evaluated = yield* evaluateTwice(guest, errors);
	if (evaluated === undefined) return undefined;

	stage('manifest');
	const { roles, bodies } = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Evaluated))(
		evaluated
	).pipe(Effect.mapError((cause) => new EvalError({ cause })));
	const { manifest, errors: text } = yield* load(
		root,
		files.filter((f) => !f.path.endsWith('.ts'))
	);
	errors.push(...text);
	for (const f of code) manifest[f.role][f.name] = roles[f.role]?.[f.name];
	errors.push(...manifestErrors(manifest));

	stage('names');
	const names = Result.try({
		try: () => namesIndex(files, manifest, bolt),
		catch: (cause) => (cause instanceof Error ? cause.message : String(cause))
	});
	if (Result.isSuccess(names)) yield* writeNames(root, names.success);
	else
		errors.push({
			code: 'names/failed',
			path: 'src',
			message: `the names index keeps its last good text: ${names.failure}`
		});
	return { files, code, guest, manifest, bodies };
});

/** `bolt sync`: evaluates the declarations at `root` and writes `.norbital/names.ts`; `bolt` is the module it augments. */
export const sync = Effect.fn('bolt.sync')(function* (
	dir: string,
	options: { bolt?: string } = {}
) {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(dir);
	const stages: Stage[] = [],
		errors: CheckDiagnostic[] = [];
	yield* front(root, (s) => stages.push(s), errors, options.bolt);
	return { stages, errors };
});

/** Checks the workspace at `root`; `bolt` is the module specifier the names index augments. */
export const check = Effect.fn('bolt.check')(function* (
	dir: string,
	options: { bolt?: string; migrations?: 'generate' | 'verify'; squash?: string } = {}
) {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(dir); // importers arrive resolved; relative paths need the same spelling
	const stages: Stage[] = [],
		errors: CheckDiagnostic[] = [];
	const stage = (s: Stage) => stages.push(s);
	const out: CheckResult = { stages, errors, transforms: [] };

	const evaluated = yield* front(root, stage, errors, options.bolt);
	if (evaluated === undefined) return out;
	const { files, code, guest, manifest, bodies } = evaluated;
	out.guest = guest;
	const decoded = decodeManifest(projectManifest(manifest));
	if (Result.isFailure(decoded)) {
		errors.push({
			code: 'manifest/invalid',
			path: 'src',
			message: decoded.failure.issues.join('\n')
		});
		return out;
	}
	const m = decoded.success;
	out.manifest = m;
	out.transforms = [...bodies.transforms];

	stage('seed');
	const pack = yield* seedPack(root, errors);
	// Identity rows are decoded by the identity area's seed path.
	const tenant = Object.fromEntries(Object.entries(pack).filter(([c]) => !c.startsWith('sys_')));
	const decodedSeed = Result.try({
		try: () => decodeSeed(m, tenant),
		catch: (cause) => new EvalError({ cause })
	});
	if (Result.isFailure(decodedSeed))
		errors.push({
			code: 'seed/decode',
			path: 'seed',
			message:
				decodedSeed.failure.cause instanceof Error
					? decodedSeed.failure.cause.message
					: String(decodedSeed.failure.cause)
		});
	else out.seed = tenant;

	stage('schema');
	const planned = yield* Effect.result(plan(null, m));
	if (Result.isFailure(planned)) {
		const e = planned.failure;
		const code =
			typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string'
				? e.code
				: 'invalid';
		errors.push({
			code: `schema/${code}`,
			path: 'src/data',
			message: e instanceof Error ? e.message : String(e)
		});
	} else {
		const migrations = yield* Effect.result(
			prepareMigrations(root, m, options.migrations ?? 'verify', {
				...(options.squash === undefined ? {} : { squash: options.squash })
			})
		);
		if (Result.isFailure(migrations)) {
			const error = migrations.failure;
			errors.push({
				code: 'schema/migrations',
				path: 'migrations',
				message: error instanceof Error ? error.message : String(error)
			});
		}
	}

	stage('rules');
	const where = (role: string, name: string) =>
		files.find((f) => f.role === role && f.name === name)?.path ?? `src (${role} ${name})`;
	errors.push(...checkRules(m, bodies, where));
	const models = files.filter((f) => f.role === 'model');
	const sources = yield* Effect.forEach(models, (f) =>
		fs.readFileString(join(root, f.path)).pipe(Effect.map((text) => ({ path: f.path, text })))
	);
	errors.push(...sourceRules(m, sources));
	if (errors.length === 0) {
		const runtime = yield* bundle(root, code, errors, true, bodies.models);
		if (runtime !== undefined) out.guest = runtime;
	}
	return out;
});

/**
 * A policy's guest part: each write grant's `approval` callback (`policy.<p>.grants.<model>.<op>.approval`), pure and
 * called with its write and a fresh flow, then reduced to the stored snapshot without a ctx.
 */
const APPROVALS = `import { approvalFlow as __approvalFlow, snapshotOf as __approvalSnapshot } from ${JSON.stringify(join(dirname(BOLT), 'decl', 'access', `policy${extname(BOLT)}`))};
const __approval = (approve) => Object.defineProperty((write) => __approvalSnapshot(approve(write, __approvalFlow())), 'name', { value: approve.name });
const __approvals = (p) => ({ grants: Object.fromEntries(Object.entries(p?.grants ?? {}).map(([model, g]) => [model, Object.fromEntries(['create', 'update', 'delete'].flatMap((op) => typeof g?.[op]?.approval === 'function' ? [[op, { approval: __approval(g[op].approval) }]] : []))])) });`;
/**
 * The callback paths selected by the runner (the Guest ABI), retaining every role module's original initialization order:
 * a model's bodies under `collection.<model>.bodies`, a policy's approval callbacks, an automation's `body`, a custom
 * field's `check`, an integration's `bodies.test` and a page server's loader.
 */
function runtimeEntry(
	root: string,
	code: readonly Discovered[],
	models: readonly string[]
): string {
	const groups = new Map<string, string[]>();
	const callbackModels = new Set(models);
	const imports = code.map((file, index) => {
		const binding = `r${index}`;
		let group: string = file.role,
			value: string | undefined;
		switch (file.role) {
			case 'model':
				group = 'collection';
				if (callbackModels.has(file.name)) value = `{ bodies: ${binding}.bodies }`;
				break;
			case 'policy':
				value = `__approvals(${binding})`;
				break;
			case 'automation':
				value = `{ body: ${binding}.body }`;
				break;
			case 'custom_field':
				value = `{ check: ${binding}.check }`;
				break;
			case 'integration_definition':
				value = `{ bodies: ${binding}.bodies }`;
				break;
			case 'page_server':
			case 'kiosk_page_server':
				value = `{ data: ${binding}.data, load: ${binding}.load }`;
				break;
		}
		const path = JSON.stringify(join(root, file.path));
		if (value === undefined) return `import ${path};`;
		const entries = groups.get(group) ?? [];
		entries.push(`${JSON.stringify(file.name)}: ${value}`);
		groups.set(group, entries);
		return `import ${binding} from ${path};`;
	});
	return [
		...imports,
		...(groups.has('policy') ? [APPROVALS] : []),
		`export default { ${[...groups].map(([group, entries]) => `${group}: { ${entries.join(', ')} }`).join(', ')} };`
	].join('\n');
}

/** Native ES modules for full declaration evaluation or the runner's callback projection, with rule 6's import walls. */
const bundle = Effect.fn('bolt.bundle')(function* (
	root: string,
	code: readonly Discovered[],
	errors: CheckDiagnostic[],
	runtime: boolean = false,
	models: readonly string[] = []
) {
	const fs = yield* FileSystem.FileSystem;
	const byRole = Map.groupBy(code, (f) => f.role);
	const servers = code.filter((f) => f.role === 'page_server' || f.role === 'kiosk_page_server');
	const entry = runtime
		? runtimeEntry(root, code, models)
		: [
				...(servers.length > 0
					? [
							`export { pageServerMetadata as __pageServerMetadata } from ${JSON.stringify(join(dirname(BOLT), 'decl', 'runtime', `page${extname(BOLT)}`))};`,
							...servers.map(
								(f, i) =>
									`import p${i} from ${JSON.stringify(join(root, dirname(f.path), `${f.name.slice(f.name.lastIndexOf('/') + 1)}.page.data.ts`))};`
							),
							`export const __pageDataCodecs = { ${[...Map.groupBy(servers, (f) => f.role)].map(([role, files]) => `${role}: { ${files.map((f) => `${JSON.stringify(f.name)}: p${servers.indexOf(f)}`).join(', ')} }`).join(', ')} };`
						]
					: []),
				...code.map((f, i) => `import r${i} from ${JSON.stringify(join(root, f.path))};`),
				`export default { ${[...byRole].map(([role, fs]) => `${role}: { ${fs.map((f) => `${JSON.stringify(f.name)}: r${code.indexOf(f)}`).join(', ')} }`).join(', ')} };`
			].join('\n');

	const assets: Record<string, Uint8Array> = {};
	const bundled = yield* Effect.tryPromise({
		try: (signal) =>
			build({
				configFile: false,
				logLevel: 'silent',
				root,
				resolve: { alias: [{ find: /^@norbital-ai\/bolt$/, replacement: BOLT }] },
				plugins: [
					{
						name: 'bolt:guest',
						enforce: 'pre',
						// repository-health:allow EFF3 -- Vite resolves through its Promise plugin ABI.
						async resolveId(id, importer) {
							if (id === ENTRY) return `\0${ENTRY}`;
							// §5.8: `import bytes from './x.wasm?bytes'` is the file's bytes, a server-only asset of the artifact
							if (id.endsWith(BYTES)) {
								// repository-health:allow EFF3 -- Vite's resolver returns a Promise.
								const file = await this.resolve(id.slice(0, -BYTES.length), importer, {
									skipSelf: true
								});
								return file === null ? null : `${BYTES_ID}${file.id}`;
							}
							if (!NODE.has(id) || importer?.startsWith('\0') === true) return null;
							const from =
								importer === undefined ? 'src' : relative(root, importer).split(sep).join('/');
							errors.push({
								code: 'guest/node-import',
								path: from,
								message: `${from}: imports '${id}'; guest code runs in the isolate, which has no node modules (rule 6)`
							});
							return { id, external: true };
						},
						transform(source, id) {
							const path = relative(root, id);
							if (
								id.startsWith('\0') ||
								path.startsWith('..') ||
								path.split(sep).includes('node_modules') ||
								!SCRIPT.test(id) ||
								!GENERATOR.test(source)
							)
								return null;
							return { code: `${EDGE}${source}`, map: null }; // one line: only line 1's columns move
						},
						load(id) {
							if (id === `\0${ENTRY}`) return entry;
							if (!id.startsWith(BYTES_ID)) return null;
							// Vite owns this Promise hook; the enclosing bundle Effect supplies cancellation and captures failures.
							return readFile(id.slice(BYTES_ID.length), { signal }).then((bytes) => {
								const sha = sha256Hex(bytes);
								assets[sha] = bytes;
								// ponytail: every invocation copies the bytes in at module evaluation; lazy access when an asset is large
								return `export default globalThis[Symbol.for('norbital.bolt.asset')](${JSON.stringify(sha)});`;
							});
						}
					}
				],
				build: {
					write: false,
					minify: 'oxc',
					sourcemap: true,
					rolldownOptions: {
						input: ENTRY,
						preserveEntrySignatures: 'strict',
						optimization: { pifeForModuleWrappers: runtime },
						output: {
							format: 'es',
							entryFileNames: 'guest.mjs',
							codeSplitting: false,
							strictExecutionOrder: true,
							// Compact bindings reduce isolate startup CPU; preserve names for runtime diagnostics and reflection.
							minify: {
								compress: { keepNames: { function: true, class: true } },
								mangle: { toplevel: true, keepNames: { function: true, class: true } },
								codegen: { removeWhitespace: true, legalComments: 'inline' }
							},
							comments: { legal: true }
						}
					}
				}
			}),
		catch: (cause) => new BundleError({ cause })
	}).pipe(
		Effect.map((output) => (Array.isArray(output) ? output[0] : output)),
		Effect.result
	);
	if (Result.isFailure(bundled)) {
		const e = bundled.failure.cause;
		errors.push({
			code: 'bundle/failed',
			path: 'src',
			message: e instanceof Error ? e.message : String(e)
		});
		return undefined;
	}
	const result = bundled.success;
	if (result === undefined || 'close' in result)
		return yield* Effect.fail(
			new BundleError({ cause: new Error('the bundler returned no output') })
		);
	const chunk = result.output.find((o): o is Rolldown.OutputChunk => o.type === 'chunk');
	if (chunk === undefined)
		return yield* Effect.fail(
			new BundleError({ cause: new Error('the bundler emitted no guest chunk') })
		);
	let source = chunk.code;
	let sourceMap = chunk.map?.toString();
	if (runtime) {
		// Compress the native output with its map; declaration validation and module ordering stay upstream.
		const inputMap = chunk.map?.toString();
		const options: MinifyOptions = {
			module: true,
			keep_fnames: true,
			keep_classnames: true,
			compress: { passes: 2, keep_fargs: true, pure_getters: false },
			mangle: { toplevel: true },
			format: { comments: 'some', wrap_func_args: true },
			sourceMap: {
				// A metadata-only runtime has no mapped source modules.
				...(inputMap === undefined ? {} : { content: inputMap }),
				filename: 'guest.mjs',
				url: 'guest.mjs.map'
			}
		};
		// Terser is deterministic and costs seconds per check: its output is reused by content (input, map and options).
		const dir = join(root, '.norbital', 'cache', 'guest');
		const file = join(dir, `${sha256Hex(JSON.stringify([chunk.code, options]))}.json`);
		const cached = yield* fs
			.readFileString(file)
			.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Minified))),
				Effect.option
			);
		let compact: typeof Minified.Type;
		if (Option.isSome(cached)) compact = cached.value;
		else {
			const output = yield* Effect.tryPromise({
				try: () => minify(chunk.code, options),
				catch: (cause) => new BundleError({ cause })
			});
			if (output.code === undefined || typeof output.map !== 'string')
				return yield* new BundleError({
					cause: new Error('the minifier emitted no guest code or map')
				});
			compact = { code: output.code, map: output.map };
			// A rename publishes the whole entry; a concurrent check writes the same bytes.
			const temporary = `${file}.${process.pid}`;
			yield* fs.makeDirectory(dir, { recursive: true });
			yield* fs.writeFileString(temporary, JSON.stringify(compact));
			yield* fs.rename(temporary, file);
		}
		source = compact.code;
		sourceMap = compact.map;
	}
	if (Buffer.byteLength(source) > GUEST_BYTES)
		errors.push({
			code: 'guest/size',
			path: 'guest.mjs',
			message: `guest.mjs is over 8 MiB (rule 6)`
		});
	return {
		source,
		...(sourceMap === undefined ? {} : { sourceMap }),
		...(Object.keys(assets).length > 0 ? { assets } : {})
	};
});

// Rule 2's evaluation context: a frozen clock and a seeded `Math.random` (mulberry32), installed before the module runs.
const FREEZE = `{ const T = ${FROZEN}, D = Date;
	globalThis.Date = class extends D { constructor(...a) { if (a.length === 0) super(T); else super(...a); } static now() { return T; } };
	let s = 0x2545f491; Math.random = () => { s = s + 0x6d2b79f5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }`;
// Declarations are data (functions drop out of JSON). A model's bodies become `true` markers in its literal (`splitModel`
// reads them) and a policy's approval callbacks `approval: true`; which write callbacks and automation bodies exist is
// read beside them. A ctx-bearing body must be a generator.
const SERIALIZE = `(() => { const d = globalThis.__ns.default, bodies = { transforms: [], automations: [], models: [] };
	const generator = (body) => {
		if (typeof body !== 'function') return;
		const original = body[Symbol.for('norbital.bolt.generator')] ?? body;
		if (Object.prototype.toString.call(original) !== '[object GeneratorFunction]') throw new Error('a ctx-bearing body must be a generator function');
	};
	const mark = (o) => { for (const [k, v] of Object.entries(o ?? {})) if (typeof v === 'function') o[k] = true; else if (v !== null && typeof v === 'object') mark(v); };
	const hasBody = (o) => typeof o === 'function' || o !== null && typeof o === 'object' && Object.values(o).some(hasBody);
	for (const [n, m] of Object.entries(d.model ?? {})) {
		if (Object.hasOwn(m?.spec ?? {}, 'actions')) throw new Error('model ' + JSON.stringify(n) + ' cannot declare named actions');
		const b = m?.bodies ?? {};
		if (hasBody(b)) bodies.models.push(n);
		for (const body of [b.create, b.update, b.delete, b.notify, ...Object.values(b.queries ?? {})]) generator(body);
		for (const s of Object.values(b.syncs ?? {})) { generator(s?.read); generator(s?.write); for (const p of Object.values(s?.parse ?? {})) generator(p); }
		for (const verb of ['create', 'update', 'delete']) if (typeof b[verb] === 'function') bodies.transforms.push(n + '.' + verb);
		mark(m?.spec);
		d.model[n] = { name: m?.name, spec: m?.spec };
	}
	for (const [n, a] of Object.entries(d.automation ?? {})) { generator(a?.body); if (typeof a?.body === 'function') bodies.automations.push(n); }
	for (const i of Object.values(d.integration_definition ?? {})) { generator(i?.bodies?.test); if (typeof i?.spec?.test === 'function') i.spec.test = true; }
	for (const f of Object.values(d.custom_field ?? {})) if (typeof f?.check === 'function' && f.spec) f.spec.check = true; // the write path calls the guest's validate
	for (const p of Object.values(d.policy ?? {})) for (const g of Object.values(p?.grants ?? {})) for (const op of ['create', 'update', 'delete']) if (typeof g?.[op]?.approval === 'function') g[op].approval = true;
	for (const role of ['page_server', 'kiosk_page_server']) for (const [name, definition] of Object.entries(d[role] ?? {})) {
		generator(definition?.load);
		d[role][name] = globalThis.__ns.__pageServerMetadata(definition, globalThis.__ns.__pageDataCodecs[role]?.[name]);
	}
	return JSON.stringify({ roles: d, bodies }); })()`;

const evaluate = Effect.fn('bolt.evaluate')(function* ({ source, assets }: GuestProgram) {
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const isolate = yield* Effect.acquireRelease(
				Effect.sync(() => new ivm.Isolate({ memoryLimit: 256 })),
				(isolate) =>
					Effect.sync(() => {
						if (!isolate.isDisposed) isolate.dispose();
					})
			);
			const run = <A>(f: () => Promise<A>) =>
				Effect.tryPromise({ try: f, catch: (cause) => new EvalError({ cause }) });
			const context = yield* run(() => isolate.createContext());
			yield* run(() =>
				context.evalClosure(
					PRELUDE,
					[() => {}, randomStream('bolt:check'), digest, assetHook(assets)],
					{ filename: 'bolt:prelude', result: { reference: true } }
				)
			);
			yield* run((): Promise<unknown> => context.eval(FREEZE));
			const module = yield* run(() => isolate.compileModule(source, { filename: 'guest.mjs' }));
			yield* run(() =>
				module.instantiate(context, (specifier) =>
					isolate.compileModule(missing(specifier, source))
				)
			);
			const start = isolate.cpuTime;
			// the wall timeout is only a runaway guard: `isolate.cpuTime` below is the budget's authority, and a busy
			// machine stretches wall time without changing CPU time
			yield* run(() => module.evaluate({ timeout: 100 * EVAL_CPU_MS }));
			const cpuMs = Number(isolate.cpuTime - start) / 1e6;
			yield* run(() => context.global.set('__ns', module.namespace.derefInto()));
			const json: unknown = yield* run((): Promise<unknown> =>
				context.eval(SERIALIZE, { copy: true })
			);
			return {
				json: yield* Schema.decodeUnknownEffect(Schema.String)(json).pipe(
					Effect.mapError((cause) => new EvalError({ cause }))
				),
				cpuMs
			};
		})
	);
});

/** A module standing in for an import the isolate lacks: every binding the bundle imports from it throws when called. */
function missing(specifier: string, source: string): string {
	const names = new Set<string>();
	for (const m of source.matchAll(
		new RegExp(
			`import\\s*([^"';]*?)\\s*from\\s*["']${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
			'g'
		)
	))
		for (const part of (/\{([^}]*)\}/.exec(m[1]!)?.[1] ?? '').split(',')) {
			const name = part.trim().split(/\s+as\s+/)[0]!;
			if (name !== '' && name !== 'default') names.add(name);
		}
	const stub = (n: string) =>
		`function () { throw new Error(${JSON.stringify(`guest code cannot use ${specifier} (${n})`)}); }`;
	return [
		`export default ${stub('default')};`,
		...[...names].map((n) => `export const ${n} = ${stub(n)};`)
	].join('\n');
}

const evaluateTwice = Effect.fn('bolt.evaluateTwice')(function* (
	program: GuestProgram,
	errors: CheckDiagnostic[]
) {
	const runs = yield* Effect.all([evaluate(program), evaluate(program)], { concurrency: 1 }).pipe(
		Effect.result
	);
	if (Result.isFailure(runs)) {
		const e = runs.failure.cause;
		const message = e instanceof Error ? e.message : String(e);
		errors.push(
			/ctx-bearing body must be a generator function/.test(message)
				? {
						code: 'guest/body-generator',
						path: 'src',
						message: 'a ctx-bearing body must be a generator function'
					}
				: /timed out/.test(message)
					? {
							code: 'guest/eval-cpu',
							path: 'guest.mjs',
							message: `module evaluation took over ${EVAL_CPU_MS} ms of CPU (rule 6)`
						}
					: {
							code: 'load/failed',
							path: 'guest.mjs',
							message: `evaluating the declarations failed: ${message}`
						}
		);
		return undefined;
	}
	const [a, b] = runs.success;
	if (a === undefined || b === undefined)
		return yield* Effect.fail(
			new EvalError({ cause: new Error('missing deterministic evaluation') })
		);
	if (sha256Hex(a.json) !== sha256Hex(b.json))
		errors.push({
			code: 'load/nondeterministic',
			path: 'src',
			message: 'two evaluations of the declarations gave different manifests (rule 2)'
		});
	// the cheaper of the two runs: a busy machine only ever adds CPU time, never removes it
	if (Math.min(a.cpuMs, b.cpuMs) > EVAL_CPU_MS)
		errors.push({
			code: 'guest/eval-cpu',
			path: 'guest.mjs',
			message: `module evaluation took over ${EVAL_CPU_MS} ms of CPU (rule 6)`
		});
	return a.json;
});

/** `seed/**\/<collection>.json[.gz]`, one pack (discover already refused unknown collections). */
export const seedPack = Effect.fn('bolt.seedPack')(function* (
	root: string,
	errors: CheckDiagnostic[]
) {
	const fs = yield* FileSystem.FileSystem;
	const pathService = yield* Path.Path;
	const dir = pathService.join(root, 'seed'),
		pack: { [c: string]: RowData[] } = {};
	if (!(yield* fs.exists(dir))) return pack;
	for (const entry of yield* fs.readDirectory(dir, { recursive: true })) {
		const absolute = pathService.join(dir, entry);
		const path = pathService.relative(root, absolute).split(pathService.sep).join('/');
		const hit = /^seed\/(?:.+\/)?([^/]+)\.json(\.gz)?$/.exec(path);
		if (
			(yield* fs.stat(absolute)).type !== 'File' ||
			hit === null ||
			path === 'seed/assets.json' ||
			path.startsWith('seed/assets/')
		)
			continue;
		const collection = hit[1];
		if (collection === undefined) continue;
		const bytes = yield* fs.readFile(absolute);
		const rows = yield* Effect.try({
			try: () => new TextDecoder().decode(hit[2] ? gunzipSync(bytes) : bytes),
			catch: (cause) => new EvalError({ cause })
		}).pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.Json)))
				)
			),
			Effect.result
		);
		if (Result.isFailure(rows))
			errors.push({ code: 'seed/decode', path, message: `${path}: ${rows.failure.message}` });
		else (pack[collection] ??= []).push(...rows.success);
	}
	return pack;
});
