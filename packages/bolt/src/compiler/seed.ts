/// <reference types="node" />
import { Effect, FileSystem, Path, Result, Schema } from 'effect';
import { gunzipSync } from 'node:zlib';
import type { RowData } from '../engine/contracts.ts';
import type { CheckDiagnostic } from '../protocol/diagnostic.ts';

/**
 * One pack's `<model>.json[.gz]` files (discover already refused unknown models): `base` is `seed/**` outside
 * `seed/test/`, `test` is `seed/test/**`. Each pack's `assets.json` and `assets/**` are not rows.
 */
export const seedPack = Effect.fn('bolt.seedPack')(function* (
	root: string,
	errors: CheckDiagnostic[],
	name: 'base' | 'test' = 'base'
) {
	const fs = yield* FileSystem.FileSystem;
	const pathService = yield* Path.Path;
	const prefix = name === 'test' ? 'seed/test' : 'seed',
		dir = pathService.join(root, prefix),
		pack: { [c: string]: RowData[] } = {};
	if (!(yield* fs.exists(dir))) return pack;
	for (const entry of yield* fs.readDirectory(dir, { recursive: true })) {
		const absolute = pathService.join(dir, entry);
		const path = pathService.relative(root, absolute).split(pathService.sep).join('/');
		const hit = /^seed\/(?:.+\/)?([^/]+)\.json(\.gz)?$/.exec(path);
		if (
			(yield* fs.stat(absolute)).type !== 'File' ||
			hit === null ||
			path === `${prefix}/assets.json` ||
			path.startsWith(`${prefix}/assets/`) ||
			(name === 'base' && path.startsWith('seed/test/'))
		)
			continue;
		const model = hit[1];
		if (model === undefined) continue;
		const bytes = yield* fs.readFile(absolute);
		const rows = yield* Effect.try({
			try: () => new TextDecoder().decode(hit[2] ? gunzipSync(bytes) : bytes),
			catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause)))
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
		else (pack[model] ??= []).push(...rows.success);
	}
	return pack;
});
