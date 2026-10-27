/// <reference types="node" />
// `build/cell.js` (compute model §14): the cell's engine as one minified classic script, bundled from the compiled
// `build/protocol/cell.js` after svelte-package (`node scripts/cell-bundle.ts`). A cell runs only the runtime: the
// build fails on any module a cell must never load, naming the chain that imports it, and on a bundle past P15's
// 2 MiB budget.
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, relative } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Console, Effect, FileSystem, Runtime, Schema } from 'effect';
import { minifySync } from 'rolldown/utils';
import { build, type Plugin, type Rolldown } from 'vite';

/** A refusal this program reports itself, as one `[cell]` message. */
class BundleFailed extends Schema.TaggedError<BundleFailed>()('BundleFailed', {
	message: Schema.String
}) {
	readonly [Runtime.errorReported] = false;
}

const ROOT = join(import.meta.dirname, '..');
const BUILD = join(ROOT, 'build');
const ENTRY = 'bolt-cell-entry';
const BUDGET = 2 * 1024 * 1024;
const BUILTINS = new Set(builtinModules);
/** Packages a cell never loads: Node, the native drivers, the MCP client, Node's Effect services, doctor, TypeScript. */
const PACKAGES =
	/^(?:isolated-vm|@electric-sql\/pglite|pg|@norbital-ai\/doctor|typescript|@modelcontextprotocol\/[^/]+|@effect\/platform-node(?:-[^/]+)?)(?:\/|$)/;
const PACKAGE_PATHS =
	/\/node_modules\/(?:isolated-vm|@electric-sql\/pglite|pg|@norbital-ai\/doctor|typescript|@modelcontextprotocol\/[^/]+|@effect\/platform-node[^/]*)\/|\/packages\/doctor\//;
/**
 * Guest source the cell hands its isolates as strings (the guest prelude, a file run's virtual Node): the bundler never
 * minifies a string, so whitespace and comments are removed, names and code untouched. Raw DEFLATE packs those exact
 * strings; the cell's existing inflater restores them once when the module evaluates.
 */
const GUEST_SOURCE = /\/build\/engine\/(?:guest\/prelude|agent\/run-js-node)\.js$/;
/** Pure SQL data modules: preserve every byte, including whitespace used by migration fingerprints. */
const SQL_SOURCE =
	/\/build\/(?:schema\/(?:json|rules)|migration-introspect|engine\/schema\/audit-sql)\.js$/;
const stripped = (source: string) => {
	// a function body (the prelude returns its hooks), so a top-level `return` parses
	const { code, errors } = minifySync('guest.js', `function __guest(){${source}\n}`, {
		compress: false,
		mangle: false
	});
	const body = /^function __guest\(\)\{([\s\S]*)\}\s*;?\s*$/.exec(code)?.[1];
	if (errors.length > 0 || body === undefined)
		throw new Error(`guest source did not minify: ${errors.map((e) => e.message).join('; ')}`);
	return body;
};
/** The cell's own modules that run for their effect on `globalThis`. */
const EFFECTFUL = /\/protocol\/cell(?:-globals)?\.js$/;
/** Bolt's own folders a cell never runs. */
const BOLT_FOLDERS =
	/(?:\/packages\/bolt|\/@norbital-ai\/bolt)\/(?:build|src)\/(?:docs|compiler|cli|node)\//;
const forbidden = (source: string) =>
	source.startsWith('node:') || BUILTINS.has(source) || PACKAGES.test(source);

/** Refuses every forbidden module as it resolves, with the importer chain back to the entry. */
const guard = (): Plugin => {
	const parents = new Map<string, string | undefined>();
	const refusal = (what: string, importer: string | undefined) => {
		const chain: string[] = [];
		for (let at = importer; at !== undefined && !chain.includes(at); at = parents.get(at))
			chain.push(at);
		return new Error(
			`the cell must not load ${what}; imported by ${chain.map((id) => relative(ROOT, id)).join(' ← ')}`
		);
	};
	return {
		name: 'bolt:cell-bundle',
		enforce: 'pre',
		// repository-health:allow EFF3 -- Vite owns this asynchronous resolver boundary.
		async resolveId(source, importer) {
			if (source === ENTRY) return `\0${ENTRY}`;
			if (forbidden(source)) throw refusal(source, importer);
			const resolved = await this.resolve(source, importer, { skipSelf: true });
			if (resolved === null) return null;
			if (PACKAGE_PATHS.test(resolved.id) || BOLT_FOLDERS.test(resolved.id))
				throw refusal(relative(ROOT, resolved.id), importer);
			if (!parents.has(resolved.id)) parents.set(resolved.id, importer);
			// the package is side-effect free, except the cell's entry and globals, whose whole work is installing them
			return EFFECTFUL.test(resolved.id) ? { ...resolved, moduleSideEffects: true } : resolved;
		},
		// repository-health:allow EFF3 -- Vite owns this asynchronous loader boundary.
		async load(id) {
			if (id === `\0${ENTRY}`)
				return `import ${JSON.stringify(join(BUILD, 'protocol', 'cell.js'))};`;
			const guest = GUEST_SOURCE.test(id);
			if (!guest && !SQL_SOURCE.test(id)) return null;
			const exported: Record<string, unknown> = await import(pathToFileURL(id).href);
			return [
				`import { Result } from 'effect';`,
				`import * as Base64 from 'effect/encoding/Base64';`,
				`import { inflateSync } from 'fflate';`,
				...Object.entries(exported).map(([name, value]) => {
					let source: string;
					let array = false;
					if (typeof value === 'string') source = guest ? stripped(value) : value;
					else if (!guest && Schema.is(Schema.Array(Schema.String))(value)) {
						if (value.length === 0 || value.some((part) => part.includes('\0')))
							throw new Error(
								`${relative(ROOT, id)}: ${name} cannot use NUL-delimited SQL packing`
							);
						source = value.join('\0');
						array = true;
					} else
						throw new Error(`${relative(ROOT, id)} exports ${name}, not supported string data`);
					const packed = deflateRawSync(Buffer.from(source, 'utf8'), { level: 9 }).toString(
						'base64'
					);
					if (inflateRawSync(Buffer.from(packed, 'base64')).toString('utf8') !== source)
						throw new Error(`${relative(ROOT, id)}: ${name} did not round-trip through DEFLATE`);
					return `export const ${name} = new TextDecoder().decode(inflateSync(Result.getOrThrow(Base64.decode(${JSON.stringify(packed)}))))${array ? ".split('\\0')" : ''};`;
				})
			].join('\n');
		}
	};
};

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const built = yield* Effect.tryPromise({
		try: () =>
			build({
				root: ROOT,
				configFile: false,
				logLevel: 'silent',
				publicDir: false,
				// neither Node's nor a browser's entry points: the cell has only its own globals
				resolve: { conditions: ['module', 'production'] },
				define: { 'process.env.NODE_ENV': JSON.stringify('production') },
				plugins: [guard()],
				build: {
					write: false,
					minify: 'oxc',
					target: 'es2024',
					modulePreload: false,
					copyPublicDir: false,
					reportCompressedSize: false,
					rolldownOptions: {
						input: ENTRY,
						platform: 'neutral',
						output: { format: 'iife', codeSplitting: false, strictExecutionOrder: true }
					}
				}
			}),
		catch: (cause) =>
			new BundleFailed({ message: cause instanceof Error ? cause.message : String(cause) })
	});
	const chunk = (Array.isArray(built) ? built : [built])
		.flatMap((result) => ('output' in result ? result.output : []))
		.find((item): item is Rolldown.OutputChunk => item.type === 'chunk' && item.isEntry);
	if (chunk === undefined) return yield* new BundleFailed({ message: 'no bundle was written' });
	const size = Buffer.byteLength(chunk.code);
	yield* Console.log(
		`[cell] build/cell.js ${(size / 1024).toFixed(0)} KiB of a ${BUDGET / 1024} KiB budget`
	);
	if (size > BUDGET)
		return yield* new BundleFailed({
			message: `build/cell.js is ${(size / 1024).toFixed(0)} KiB, over the ${BUDGET / 1024} KiB budget`
		});
	yield* fs.writeFileString(join(BUILD, 'cell.js'), chunk.code);
});

NodeRuntime.runMain(
	program.pipe(
		Effect.tapErrorTag('BundleFailed', (error) => Console.error(`[cell] ${error.message}`)),
		Effect.provide(NodeServices.layer)
	)
);
