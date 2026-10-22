/// <reference types="node" />
import { Effect, FileSystem, Option, Path, Result, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/unstable/process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from '@norbital-ai/doctor';
import {
	buildPacks,
	readArtifact,
	readPack,
	templateMeta,
	writeArtifact,
	type PackJson
} from '../compiler/artifact/index.ts';
import { check, seedPack, type CheckDiagnostic } from '../compiler/check/index.ts';
import { discover } from '../compiler/discover.ts';
import { typeIndex, type TypeIndex, type TypeProgram } from '../compiler/artifact/types.ts';
import { writeTypeSetup } from '../compiler/names.ts';

export type Log = (line: string) => void;
const Diagnostic = Schema.Struct({
	code: Schema.String,
	path: Schema.String,
	message: Schema.String,
	line: Schema.optionalKey(Schema.Number),
	help: Schema.optionalKey(Schema.String)
});
export class AuthorErrors extends Schema.TaggedError<AuthorErrors>()('AuthorErrors', {
	message: Schema.String,
	errors: Schema.Array(Diagnostic)
}) {}
export class ToolFailure extends Schema.TaggedError<ToolFailure>()('ToolFailure', {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect())
}) {}
const toolFailure = (cause: unknown) =>
	new ToolFailure({ message: cause instanceof Error ? cause.message : String(cause), cause });
const Bin = Schema.Struct({
	bin: Schema.optionalKey(
		Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])
	)
});
export function bin(pkg: string, name: string, from: string): string | undefined {
	for (const base of [join(from, 'package.json'), fileURLToPath(import.meta.url)]) {
		const found = Result.try(() => {
			const require = createRequire(base),
				manifest = require.resolve(`${pkg}/package.json`);
			const decoded = Schema.decodeUnknownOption(Bin)(require(manifest));
			if (decoded._tag === 'None') return undefined;
			const rel =
				typeof decoded.value.bin === 'string' ? decoded.value.bin : decoded.value.bin?.[name];
			return rel === undefined ? undefined : join(dirname(manifest), rel);
		});
		if (Result.isSuccess(found) && found.success !== undefined) return found.success;
	}
	return undefined;
}
export const doctorFindings = Effect.fn('bolt.doctorFindings')(function* (
	root: string,
	program?: TypeProgram
) {
	const findings = yield* Effect.try({
		try: () => doctor({ root, ...(program === undefined ? {} : { program }) }),
		catch: toolFailure
	});
	return findings.map((finding): CheckDiagnostic => {
		const location = /^(.+?):(\d+): ([\s\S]*)$/.exec(finding.location);
		return location === null
			? {
					code: `doctor/${finding.rule}`,
					path: finding.location,
					message: `${finding.location}: ${finding.summary}`
				}
			: {
					code: `doctor/${finding.rule}`,
					path: location[1] ?? finding.location,
					line: Number(location[2]),
					message: `${location[1]}:${location[2]}: ${finding.summary} — ${location[3]?.trim() ?? ''}`
				};
	});
});
/** The checker's diagnostics, once: svelte-check where a component needs it (it checks every .ts file too), else tsc. */
const toolDiagnostics = Effect.fn('bolt.toolDiagnostics')(function* (root: string) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path;
	if (!(yield* fs.exists(path.join(root, 'tsconfig.json')))) return [];
	const run = Effect.fn('bolt.types.run')(function* (
		tool: string,
		file: string | undefined,
		args: readonly string[],
		parse: (line: string) => CheckDiagnostic | null
	) {
		if (file === undefined)
			return [
				{ code: `types/${tool}`, path: 'tsconfig.json', message: `${tool} is not installed` }
			];
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const child = yield* ChildProcess.make(process.execPath, [file, ...args], { cwd: root });
				const [stdout, stderr, exit] = yield* Effect.all(
					[
						child.stdout.pipe(Stream.decodeText(), Stream.mkString),
						child.stderr.pipe(Stream.decodeText(), Stream.mkString),
						child.exitCode
					],
					{ concurrency: 'unbounded' }
				);
				const output = `${stdout}\n${stderr}`,
					found = output
						.split(/\n(?![ \t])/)
						.map(parse)
						.filter((diagnostic) => diagnostic !== null);
				return exit !== 0 && found.length === 0
					? [
							{
								code: `types/${tool}`,
								path: 'tsconfig.json',
								message: `${tool} exited ${exit}: ${output.trim().slice(0, 2000)}`
							}
						]
					: found;
			})
		).pipe(
			Effect.timeoutOrElse({
				duration: '120 seconds',
				orElse: () => Effect.fail(new ToolFailure({ message: `${tool} exceeded 120 seconds` }))
			})
		);
	});
	const sources = yield* fs.readDirectory(path.join(root, 'src'), { recursive: true });
	if (sources.some((file) => file.endsWith('.svelte')))
		return [
			...(yield* run(
				'svelte-check',
				bin('svelte-check', 'svelte-check', root),
				['--tsconfig', './tsconfig.json', '--output', 'machine', '--fail-on-warnings'],
				(line) => {
					const match = /^\d+ (ERROR|WARNING) "(.+?)" (\d+):(\d+) "(.*)"$/.exec(line);
					return match === null
						? null
						: {
								code: 'types/svelte',
								path: match[2] ?? 'tsconfig.json',
								line: Number(match[3]),
								message: `${match[2]}:${match[3]}:${match[4]}: ${match[5]}`
							};
				}
			))
		];
	return yield* run(
		'tsc',
		bin('@typescript/native', 'tsc', root) ?? bin('typescript', 'tsc', root),
		[
			'-p',
			'tsconfig.json',
			'--noEmit',
			'--incremental',
			'--tsBuildInfoFile',
			'.norbital/typecheck.tsbuildinfo',
			'--pretty',
			'false'
		],
		(line) => {
			const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): ([\s\S]*?)\s*$/.exec(line);
			return match === null
				? null
				: {
						code: `types/${match[4]}`,
						path: match[1] ?? 'tsconfig.json',
						line: Number(match[2]),
						message: `${match[1]}:${match[2]}:${match[3]}: ${match[5]}`
					};
		}
	);
});
/** The type diagnostics: the checker's, then doctor's (type-aware when it is given the type index's program). */
const typeDiagnostics = (root: string, program?: TypeProgram) =>
	Effect.map(
		Effect.all([toolDiagnostics(root), doctorFindings(root, program)]),
		([tool, doctor]) => [...tool, ...doctor]
	);
const TypeCache = Schema.Struct({
	key: Schema.String,
	diagnostics: Schema.Array(Diagnostic),
	index: Schema.optionalKey(
		Schema.Struct({
			entries: Schema.Record(
				Schema.String,
				Schema.Struct({
					type: Schema.String,
					docs: Schema.optionalKey(Schema.String),
					source: Schema.optionalKey(Schema.String)
				})
			),
			errors: Schema.Array(Schema.String)
		})
	)
});
const SKIPPED = new Set(['node_modules', '.norbital', '.git', '.svelte-kit', 'dist']);
/**
 * What the type stage judges: every authored file, and the identity of each judging package (a same-version
 * republish or a relink replaces its files, so its inode and time move with it).
 */
const typeKey = Effect.fn('bolt.typeKey')(function* (root: string) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path,
		hash = createHash('sha256');
	// the heavy and derived folders sit at the root; everything else is the workspace's own
	const files: string[] = [];
	for (const name of (yield* fs.readDirectory(root)).toSorted()) {
		if (SKIPPED.has(name)) continue;
		const at = path.join(root, name);
		if ((yield* fs.stat(at)).type === 'File') files.push(name);
		else
			for (const inner of (yield* fs.readDirectory(at, { recursive: true })).toSorted())
				if ((yield* fs.stat(path.join(at, inner))).type === 'File')
					files.push(path.join(name, inner));
	}
	for (const file of files)
		hash.update(`\0${file}\0`).update(yield* fs.readFile(path.join(root, file)));
	const scope = path.join(root, 'node_modules', '@norbital-ai');
	const judges = [
		...((yield* fs.exists(scope))
			? (yield* fs.readDirectory(scope)).map((n) => `@norbital-ai/${n}`)
			: []),
		'svelte-check',
		'typescript'
	].toSorted();
	for (const name of judges) {
		const manifest = path.join(root, 'node_modules', name, 'package.json');
		if (!(yield* fs.exists(manifest))) continue;
		const info = yield* fs.stat(yield* fs.realPath(manifest));
		hash.update(
			`\0${name}\0${Option.getOrElse(info.ino, () => 0)}\0${Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() })}\0`
		);
	}
	return hash.digest('hex');
});
const typeCache = Effect.fn('bolt.typeCache')(function* (root: string, key: string) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path;
	const cached = yield* fs
		.readFileString(path.join(root, '.norbital', 'cache', 'types.json'))
		.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TypeCache))),
			Effect.option
		);
	return Option.filter(cached, (entry) => entry.key === key);
});
const keepTypes = Effect.fn('bolt.keepTypes')(function* (
	root: string,
	entry: typeof TypeCache.Type
) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path,
		dir = path.join(root, '.norbital', 'cache');
	yield* fs.makeDirectory(dir, { recursive: true });
	yield* fs.writeFileString(path.join(dir, 'types.json'), JSON.stringify(entry));
});
/** The type stage of `bolt check`: unchanged sources and toolchain answer from the cache. */
export const types = Effect.fn('bolt.types')(function* (root: string) {
	yield* writeTypeSetup(root);
	const key = yield* typeKey(root),
		hit = yield* typeCache(root, key);
	if (Option.isSome(hit)) return [...hit.value.diagnostics];
	const diagnostics = yield* typeDiagnostics(root);
	yield* keepTypes(root, { key, diagnostics });
	return diagnostics;
});
/**
 * A build's type stage: the type index's program is the one doctor's type-aware pass reads, and an unchanged workspace
 * answers both its diagnostics and its index from the cache.
 */
const typedBuild = Effect.fn('bolt.typedBuild')(function* (
	root: string,
	manifest: Parameters<typeof typeIndex>[1] | undefined,
	checks: boolean
) {
	yield* writeTypeSetup(root);
	const key = yield* typeKey(root),
		hit = yield* typeCache(root, key);
	if (Option.isSome(hit) && hit.value.index !== undefined)
		return { diagnostics: [...hit.value.diagnostics], index: hit.value.index };
	// the checker runs in its own process before this one builds its program: the two programs never share the memory
	const tool = !checks || Option.isSome(hit) ? [] : yield* toolDiagnostics(root);
	const built = manifest === undefined ? undefined : yield* typeIndex(root, manifest);
	const diagnostics = Option.isSome(hit)
		? [...hit.value.diagnostics]
		: checks
			? [...tool, ...(yield* doctorFindings(root, built?.program))]
			: [];
	const index: TypeIndex | undefined = built?.index;
	// only checked results are kept: an unchecked build's empty diagnostics must never answer a later check
	if (checks || Option.isSome(hit))
		yield* keepTypes(root, { key, diagnostics, ...(index === undefined ? {} : { index }) });
	return { diagnostics, index };
});
/** Everything the base pack is built from: the seed tree, the schema it is written against and the locked toolchain. */
const seedInputs = Effect.fn('bolt.seedInputs')(function* (root: string, schema: string) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path,
		hash = createHash('sha256').update(schema),
		seed = path.join(root, 'seed'),
		lock = path.join(root, 'pnpm-lock.yaml');
	if (yield* fs.exists(lock)) hash.update(yield* fs.readFile(lock));
	if (yield* fs.exists(seed))
		for (const file of (yield* fs.readDirectory(seed, { recursive: true })).toSorted()) {
			const at = path.join(seed, file);
			if ((yield* fs.stat(at)).type !== 'File') continue;
			hash.update(`\0${file}\0`).update(yield* fs.readFile(at));
		}
	return hash.digest('hex');
});
/**
 * Every build is a full build (a Studio preview's is the one its publish reuses); any build reuses an unchanged base
 * pack and unchanged type results.
 * `checked` is source its own repository's CI already checked (a published template): its type index is built (the
 * agent reads it), the checks are not run again.
 */
export const buildWorkspace = Effect.fn('bolt.buildWorkspace')(function* (
	dir: string,
	options: { bank?: string; types?: boolean; checked?: boolean; log?: Log } = {}
) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path,
		root = yield* fs.realPath(dir),
		typed = options.types !== false;
	const checked = yield* check(root),
		errors = [...checked.errors];
	const typing = typed
		? yield* typedBuild(root, checked.manifest, options.checked !== true)
		: undefined;
	if (typing !== undefined) errors.push(...typing.diagnostics);
	if (errors.length > 0 || checked.manifest === undefined || checked.guest === undefined)
		return yield* Effect.fail(new AuthorErrors({ errors, message: `${errors.length} errors` }));
	const { files } = yield* discover(root),
		out = path.join(root, '.norbital', 'artifact');
	const index = typing?.index;
	for (const warning of index?.errors ?? []) options.log?.(`warning: types.json: ${warning}`);
	const artifact = yield* writeArtifact(
		root,
		{ ...checked, manifest: checked.manifest, guest: checked.guest },
		files,
		out,
		index
	);
	const seedOut = path.join(root, '.norbital', 'seed'),
		stampFile = path.join(seedOut, 'inputs.sha256'),
		stamp = yield* seedInputs(root, artifact.schema);
	// a pack is a function of its stamped inputs: an unchanged one is reused by any build that reads no bank
	const reused =
		options.bank === undefined &&
		(yield* fs.exists(path.join(seedOut, 'base', 'pack.json'))) &&
		(yield* fs.readFileString(stampFile).pipe(Effect.catch(() => Effect.succeed('')))) === stamp;
	let packs: { [pack: string]: PackJson };
	if (reused) packs = { base: (yield* readPack(path.join(seedOut, 'base'))).meta };
	else {
		yield* fs.remove(stampFile, { force: true });
		const packErrors: CheckDiagnostic[] = [],
			meta = yield* templateMeta(root),
			seed = yield* seedPack(root, []);
		packs = yield* buildPacks(
			root,
			checked.manifest,
			seed,
			seedOut,
			{
				...(options.bank === undefined ? {} : { bank: path.resolve(options.bank) }),
				...(meta.bank === undefined ? {} : { tree: meta.bank }),
				cache: path.join(root, '.norbital', 'cache')
			},
			packErrors
		);
		if (packErrors.length > 0)
			return yield* Effect.fail(
				new AuthorErrors({ errors: packErrors, message: `${packErrors.length} seed errors` })
			);
		yield* fs.makeDirectory(seedOut, { recursive: true });
		yield* fs.writeFileString(stampFile, stamp);
	}
	options.log?.(
		`built ${artifact.handle} ${artifact.hash.slice(0, 12)} (schema ${artifact.schema.slice(0, 12)}) → ${out}`
	);
	for (const [name, pack] of Object.entries(packs))
		options.log?.(
			`  seed pack ${name} ${pack.hash.slice(0, 12)}: ${
				Object.entries(pack.rows)
					.map(([collection, count]) => `${collection}=${count}`)
					.join(' ') || 'empty'
			}${pack.start.length > 0 ? `; start ${pack.start.join(', ')}` : ''}`
		);
	return { artifact: yield* readArtifact(out), packs };
});
