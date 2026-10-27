/// <reference types="node" />
// A fresh process catches eager imports hidden by Vitest's shared module graph.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from '@effect/vitest';

it('starts the CLI and compiles declarations without authoring tooling packages', () => {
	const root = mkdtempSync(join(tmpdir(), 'bolt-tooling-'));
	try {
		mkdirSync(join(root, 'src'));
		writeFileSync(join(root, 'src/+workspace.ts'), "export default { tz: 'UTC', locale: 'en' };\n");
		const cli = new URL('../src/cli/main.ts', import.meta.url).href,
			compiler = new URL('../src/compiler/check/index.ts', import.meta.url).href;
		const result = spawnSync(
			process.execPath,
			[
				'--no-node-snapshot',
				'--input-type=module',
				'--eval',
				`import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Effect } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
registerHooks({ resolve(specifier, context, nextResolve) {
	if (['typescript', 'svelte2tsx', '@typescript/native', '@norbital-ai/doctor'].some(name => specifier === name || specifier.startsWith(name + '/')))
		throw new Error('Build imported authoring tooling: ' + specifier);
	return nextResolve(specifier, context);
} });
await import(${JSON.stringify(cli)});
const { compile } = await import(${JSON.stringify(compiler)});
const compiled = await Effect.runPromise(compile(${JSON.stringify(root)}, { migrations: 'generate' }).pipe(Effect.provide(NodeServices.layer)));
assert.deepEqual(compiled.errors, []);
assert.deepEqual(compiled.stages, ['discover', 'bundle', 'evaluate', 'manifest', 'names', 'schema']);
assert.ok(compiled.manifest);
assert.ok(compiled.guest);`
			],
			{ cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }
		);
		expect(result.error).toBeUndefined();
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
