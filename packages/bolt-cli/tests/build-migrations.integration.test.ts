import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { tree_hash } from '@norbital-ai/host-api';
import { generateMigrations } from '../src/cli/build.ts';

it.live('generates editable migrations and preserves the previously published bundle', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const root = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-build-migrations-' });
		const models = join(root, 'src/data/model/note');
		yield* fs.makeDirectory(models, { recursive: true });
		yield* fs.writeFileString(
			join(root, 'src/+workspace.ts'),
			"import { workspace } from '@norbital-ai/bolt'; export default workspace({tz:'UTC',locale:'en'});"
		);
		const model = join(models, '+model.ts');
		const note = (fields: string) =>
			`import { model } from '@norbital-ai/bolt'; export default model('note',{description:'A note',fields:{${fields}},outputs:{default:{fields:'all'}}});`;
		yield* fs.writeFileString(model, note("name:{kind:'text'}"));
		const bundle = join(root, '.norbital/bundle');
		const editable = join(root, 'migrations');
		// The sandbox collects bundle/migrations when it invokes this command in a fresh job.
		yield* generateMigrations(root);
		expect(yield* tree_hash(join(bundle, 'migrations'))).toBe(yield* tree_hash(editable));

		// A completed release is immutable while the next revision is authored, including its own migration history.
		yield* fs.writeFileString(join(bundle, 'artifact.json'), '{"hash":"published"}');
		yield* fs.makeDirectory(join(bundle, 'client'), { recursive: true });
		yield* fs.writeFileString(join(bundle, 'client/index.js'), 'export default 1;');
		const published = yield* tree_hash(bundle);
		const previous = yield* tree_hash(editable);
		yield* fs.writeFileString(model, note("name:{kind:'text'}, body:{kind:'text',optional:true}"));
		yield* generateMigrations(root);
		expect(yield* tree_hash(editable)).not.toBe(previous);
		expect(yield* tree_hash(bundle)).toBe(published);
		expect(yield* tree_hash(join(bundle, 'migrations'))).toBe(previous);
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
