/// <reference types="node" />
import { Effect, FileSystem, Path, Result, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/unstable/process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from '@norbital-ai/doctor';
import {
	buildPacks,
	readArtifact,
	templateMeta,
	writeArtifact
} from '../compiler/artifact/index.ts';
import { check, seedPack, type CheckDiagnostic } from '../compiler/check/index.ts';
import { discover } from '../compiler/discover.ts';
import { typeIndex } from '../compiler/artifact/types.ts';
import { writeTypeSetup } from '../compiler/names.ts';

export type Log = (line: string) => void;
export class AuthorErrors extends Schema.TaggedError<AuthorErrors>()('AuthorErrors', {
	message: Schema.String,
	errors: Schema.Array(
		Schema.Struct({
			code: Schema.String,
			path: Schema.String,
			message: Schema.String,
			line: Schema.optionalKey(Schema.Number),
			help: Schema.optionalKey(Schema.String)
		})
	)
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
export const doctorFindings = Effect.fn('bolt.doctorFindings')(function* (root: string) {
	const findings = yield* Effect.try({ try: () => doctor({ root }), catch: toolFailure });
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
export const types = Effect.fn('bolt.types')(function* (root: string) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path;
	yield* writeTypeSetup(root);
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
	const errors = yield* run(
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
	const sources = yield* fs.readDirectory(path.join(root, 'src'), { recursive: true });
	if (sources.some((file) => file.endsWith('.svelte')))
		errors.push(
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
		);
	errors.push(...(yield* doctorFindings(root)));
	return errors;
});
export const buildWorkspace = Effect.fn('bolt.buildWorkspace')(function* (
	dir: string,
	options: { bank?: string; types?: boolean; log?: Log } = {}
) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path,
		root = yield* fs.realPath(dir);
	const checked = yield* check(root),
		errors = [...checked.errors];
	if (options.types !== false) errors.push(...(yield* types(root)));
	if (errors.length > 0 || checked.manifest === undefined || checked.guest === undefined)
		return yield* Effect.fail(new AuthorErrors({ errors, message: `${errors.length} errors` }));
	const { files } = yield* discover(root),
		out = path.join(root, '.norbital', 'artifact');
	const index = options.types === false ? undefined : yield* typeIndex(root, checked.manifest);
	for (const warning of index?.errors ?? []) options.log?.(`warning: types.json: ${warning}`);
	const artifact = yield* writeArtifact(
		root,
		{ ...checked, manifest: checked.manifest, guest: checked.guest },
		files,
		out,
		index
	);
	const packErrors: CheckDiagnostic[] = [],
		meta = yield* templateMeta(root),
		seed = yield* seedPack(root, []);
	const packs = yield* buildPacks(
		root,
		checked.manifest,
		seed,
		path.join(root, '.norbital', 'seed'),
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
