// Catalogue counts are generated from source roles, never a second handwritten inventory.
import { Effect, FileSystem, Path, Schema } from 'effect';
import { TemplateManifest } from '@norbital-ai/bolt/protocol';

/** Authored catalogue copy may omit counts; the build derives them. */
export const TemplateSource = Schema.Struct({
	...TemplateManifest.fields,
	counts: Schema.optionalKey(TemplateManifest.fields.counts)
});
export const actualCounts = Effect.fn('bolt.templateCounts')(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const count = Effect.fnUntraced(function* (folder: string, pattern: RegExp) {
		const dir = path.join(directory, folder);
		if (!(yield* fs.exists(dir))) return 0;
		let total = 0;
		for (const name of yield* fs.readDirectory(dir, { recursive: true }))
			if (
				pattern.test(name.split(path.sep).join('/')) &&
				(yield* fs.stat(path.join(dir, name))).type === 'File'
			)
				total += 1;
		return total;
	});
	const [models, apps, automations] = yield* Effect.all(
		[
			count('src/data/model', /^(?:[^/]+\/)+\+model\.ts$/),
			count('src/app', /(?:^|\/)\+app\.ts$/),
			count('src/automation', /^\+[^/]+\.automation\.ts$/)
		],
		{ concurrency: 3 }
	);
	return { models, apps, automations };
});

/** Refresh generated counts, preserving authored catalogue copy and extension fields. */
export const templateMetadata = Effect.fn('bolt.templateMetadata')(function* (root: string) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path;
	const file = path.join(root, 'norbital.template.json');
	if (!(yield* fs.exists(file))) return { handle: path.basename(root), name: path.basename(root) };
	const source = yield* Schema.decodeUnknownEffect(
		Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
	)(yield* fs.readFileString(file));
	const metadata = yield* Schema.decodeUnknownEffect(TemplateSource)(source);
	const counts = yield* actualCounts(root),
		previous = metadata.counts;
	if (
		previous === undefined ||
		previous.models !== counts.models ||
		previous.apps !== counts.apps ||
		previous.automations !== counts.automations
	)
		yield* fs.writeFileString(file, `${JSON.stringify({ ...source, counts }, null, '\t')}\n`);
	return { handle: metadata.key, name: metadata.name };
});
