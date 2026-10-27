/// <reference types="node" />
import { Effect, FileSystem, Path, Result, Schema } from 'effect';
import { gunzipSync } from 'node:zlib';
import type { RowData } from '../engine/contracts.ts';
import type { CheckDiagnostic } from '../protocol/diagnostic.ts';

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
		else (pack[collection] ??= []).push(...rows.success);
	}
	return pack;
});
