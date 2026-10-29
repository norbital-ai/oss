/// <reference types="node" />
import { Effect, FileSystem, Path, Result, Schema } from 'effect';
import { gunzipSync } from 'node:zlib';
import type { RowData } from '@norbital-ai/bolt/engine';
import type { CheckDiagnostic } from '@norbital-ai/bolt/tooling';

/**
 * The rows of a seed directory (docs/seeding.md), in natural path order: every `**\/<model>.json[.gz]` under `dir` is
 * that model's rows, as stored; its `assets.json` and `assets/**` are not rows. `label` names `dir` in diagnostics (`seed/public`,
 * `seed/test`, a bank tree's `rows`).
 */
export const rowsIn = Effect.fn('bolt.rowsIn')(function* (
	dir: string,
	label: string,
	errors: CheckDiagnostic[]
) {
	const fs = yield* FileSystem.FileSystem;
	const pathService = yield* Path.Path;
	const pack: { [c: string]: RowData[] } = {};
	if (!(yield* fs.exists(dir))) return pack;
	// natural order (`version_2` before `version_10`): a row may reference one an earlier file holds
	for (const entry of (yield* fs.readDirectory(dir, { recursive: true })).toSorted((a, b) =>
		a.localeCompare(b, 'en', { numeric: true })
	)) {
		const absolute = pathService.join(dir, entry);
		const relative = entry.split(pathService.sep).join('/');
		const path = `${label}/${relative}`;
		const hit = /^(?:.+\/)?([^/]+)\.json(\.gz)?$/.exec(relative);
		if (
			(yield* fs.stat(absolute)).type !== 'File' ||
			hit === null ||
			relative === 'assets.json' ||
			relative.startsWith('assets/')
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
/** A template's `seed/public/**` (`base`) or `seed/test/**` (`test`) rows. */
export const seedPack = (root: string, errors: CheckDiagnostic[], name: 'base' | 'test' = 'base') =>
	Effect.flatMap(Path.Path, (path) => {
		const label = name === 'test' ? 'seed/test' : 'seed/public';
		return rowsIn(path.join(root, label), label, errors);
	});
