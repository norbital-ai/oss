/// <reference types="node" />
import { Effect, FileSystem, Path, Schema } from 'effect';
import { createHash } from 'node:crypto';
import { templateMeta, writeArtifact } from '../compiler/artifact/index.ts';
import { buildPacks } from '../compiler/artifact/seed.ts';
import { readArtifact } from '../engine/artifact/read.ts';
import { readPack, type PackJson } from '../engine/write/pack.ts';
import { compile } from '../compiler/check/index.ts';
import { seedPack } from '../compiler/seed.ts';
import { Diagnostic, type CheckDiagnostic } from '../protocol/diagnostic.ts';
import { discover } from '../compiler/discover.ts';

export type Log = (line: string) => void;
export class AuthorErrors extends Schema.TaggedError<AuthorErrors>()('AuthorErrors', {
	message: Schema.String,
	errors: Schema.Array(Diagnostic)
}) {}
export class ToolFailure extends Schema.TaggedError<ToolFailure>()('ToolFailure', {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect())
}) {}
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
 * Every build is a full build (a Studio preview's is the one its merge reuses) through declaration compilation; the
 * authoring diagnostics and type check are `bolt check`, and the audit is doctor's. Any build reuses an unchanged
 * base pack.
 */
export const buildWorkspace = Effect.fn('bolt.buildWorkspace')(function* (
	dir: string,
	options: { bank?: string; log?: Log; squash?: string } = {}
) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path,
		root = yield* fs.realPath(dir);
	const checked = yield* compile(root, {
			migrations: 'generate',
			...(options.squash === undefined ? {} : { squash: options.squash })
		}),
		errors = checked.errors;
	if (errors.length > 0 || checked.manifest === undefined || checked.guest === undefined)
		return yield* Effect.fail(new AuthorErrors({ errors, message: `${errors.length} errors` }));
	const { files } = yield* discover(root),
		out = path.join(root, '.norbital', 'artifact');
	const artifact = yield* writeArtifact(
		root,
		{ manifest: checked.manifest, guest: checked.guest },
		files,
		out
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
			seed = yield* seedPack(root, packErrors);
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
					.map(([model, count]) => `${model}=${count}`)
					.join(' ') || 'empty'
			}${pack.start.length > 0 ? `; start ${pack.start.join(', ')}` : ''}`
		);
	return { artifact: yield* readArtifact(out), packs };
});
