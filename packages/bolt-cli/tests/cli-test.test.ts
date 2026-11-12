/// <reference types="node" />
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { authorErrors } from '../src/cli/build.ts';
import { suiteWorkers, testWorkspace, workers } from '../src/cli/test.ts';

it('a failed build names its first diagnostic, never only a count', () => {
	expect(
		authorErrors([{ code: 'E1', path: 'src/a.ts', message: 'amount is not a decimal' }]).message
	).toBe('1 error: amount is not a decimal');
	expect(authorErrors([]).message).toBe('The workspace could not be built.');
});

it('a suite forks a worker per free core, and only 4 on a busy machine', () => {
	expect(suiteWorkers(0)).toBe(workers);
	expect(suiteWorkers(80)).toBe(Math.min(workers, 4));
	expect(suiteWorkers(workers - 6)).toBe(Math.min(workers, 6));
});

it.live('bolt test generates the fresh checkout config before loading Vitest', () =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), 'bolt-test-fresh-')))),
			(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
		);
		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({ name: 'fresh-test-fixture', type: 'module' })
		);
		writeFileSync(
			join(root, 'tsconfig.json'),
			JSON.stringify({ extends: './.norbital/tsconfig.json' })
		);
		mkdirSync(join(root, 'node_modules/vitest'), { recursive: true });
		writeFileSync(
			join(root, 'node_modules/vitest/package.json'),
			JSON.stringify({ name: 'vitest', exports: { './node': null } })
		);
		const generated = join(root, '.norbital', 'tsconfig.json');
		expect(existsSync(generated)).toBe(false);
		// An unavailable runner must not prevent the preflight; block parent/global package resolution too.
		expect(yield* testWorkspace(root, []).pipe(Effect.flip)).toMatchObject({
			_tag: 'ToolFailure',
			message: 'bolt test: vitest is not installed'
		});
		expect(
			Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
				readFileSync(generated, 'utf8')
			)
		).toHaveProperty('compilerOptions');
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
