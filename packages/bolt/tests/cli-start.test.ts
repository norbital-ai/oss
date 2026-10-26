/// <reference types="node" />
// `bolt start` resolves bolt-server from the workspace and forwards its supported flags to the native main.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, Schema } from 'effect';
import { main } from '../src/cli/main.ts';

it.live(
	'bolt start calls the resolved native bolt-server main with its flags and maps its exit',
	() =>
		Effect.gen(function* () {
			const cwd = process.cwd();
			const scratch = yield* Effect.acquireRelease(
				Effect.sync(() => mkdtempSync(join(tmpdir(), 'cli-start-'))),
				(dir) =>
					Effect.sync(() => {
						process.chdir(cwd);
						rmSync(dir, { recursive: true, force: true });
					})
			);
			const pkg = join(scratch, 'node_modules/@norbital-ai/bolt-server');
			mkdirSync(pkg, { recursive: true });
			writeFileSync(
				join(scratch, 'package.json'),
				JSON.stringify({ name: 'ws', private: true, type: 'module' })
			);
			writeFileSync(
				join(pkg, 'package.json'),
				JSON.stringify({
					name: '@norbital-ai/bolt-server',
					type: 'module',
					exports: { '.': { default: './index.js' } }
				})
			);
			const effect = pathToFileURL(createRequire(import.meta.url).resolve('effect')).href;
			writeFileSync(
				join(pkg, 'index.js'),
				`import { Effect } from ${JSON.stringify(effect)}; import { writeFileSync } from 'node:fs';
export function main(argv) { return Effect.sync(() => { writeFileSync(${JSON.stringify(join(scratch, 'argv.json'))}, JSON.stringify(argv)); return argv.includes('--dev') ? 0 : 7; }); }`
			);
			process.chdir(scratch);
			expect(
				yield* main([
					'start',
					'--seed=sample',
					'--founder=dev@example.test',
					'--trust-proxy=127.0.0.1',
					'--dev'
				])
			).toBe(0);
			const forwarded = Schema.decodeUnknownSync(
				Schema.fromJsonString(Schema.Array(Schema.String))
			)(readFileSync(join(scratch, 'argv.json'), 'utf8'));
			expect(forwarded).toEqual([
				'--seed=sample',
				'--founder=dev@example.test',
				'--trust-proxy=127.0.0.1',
				'--dev'
			]);
			expect(yield* main(['start', '--port=1', 'x'])).toBe(2);
			expect(
				Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
					readFileSync(join(scratch, 'argv.json'), 'utf8')
				)
			).toEqual(['--port=1', 'x']);
			expect(yield* main(['start'])).toBe(2);
		}).pipe(Effect.provide(NodeServices.layer))
);
