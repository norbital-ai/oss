/// <reference types="node" />
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect, it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect } from 'effect';
import { bin, types } from '../src/cli/build.ts';

it.live.each([false, true])(
	'incremental checks retain errors and invalidate dependencies/configuration (native=%s)',
	(native) =>
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.sync(() => mkdtempSync(join(tmpdir(), 'norbital-types-'))),
				(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
			);
			const write = (file: string, text: string) => writeFileSync(join(root, file), text);
			const diagnostics = () =>
				Effect.gen(function* () {
					const found = yield* types(root);
					expect(found.filter((d) => d.code === 'types/tsc')).toEqual([]);
					return found.filter((d) => /^types\/TS\d+$/.test(d.code));
				});
			mkdirSync(join(root, 'src'));
			if (native) {
				const tool = bin('@typescript/native-preview', 'tsgo', process.cwd());
				if (tool === undefined) throw new Error('Native compiler is not installed');
				const installed = join(root, 'node_modules/@typescript/native');
				mkdirSync(installed, { recursive: true });
				write(
					'node_modules/@typescript/native/package.json',
					JSON.stringify({
						name: '@typescript/native',
						bin: { tsc: relative(realpathSync(installed), tool) }
					})
				);
			}

			const config = {
				compilerOptions: {
					strict: true,
					skipLibCheck: true,
					types: [],
					target: 'ES2024',
					module: 'NodeNext'
				},
				include: ['src/**/*.ts']
			};
			write('tsconfig.json', JSON.stringify(config));
			write('src/value.ts', 'export const value = 1;');
			write('src/main.ts', "import { value } from './value.js'; const n: number = value;");
			expect(yield* diagnostics()).toEqual([]);
			expect(existsSync(join(root, '.norbital/typecheck.tsbuildinfo'))).toBe(true);
			expect(yield* diagnostics()).toEqual([]);
			write('src/value.ts', "export const value = 'changed';");
			const errors = yield* diagnostics();
			expect(errors).toEqual([
				expect.objectContaining({ code: 'types/TS2322', path: 'src/main.ts', line: 1 })
			]);
			expect(yield* diagnostics()).toEqual(errors);
			write(
				'src/main.ts',
				"import { value } from './value.js'; const n: string = value; const optional: string = null;"
			);
			expect(yield* diagnostics()).toEqual([expect.objectContaining({ code: 'types/TS2322' })]);
			write(
				'tsconfig.json',
				JSON.stringify({
					...config,
					compilerOptions: { ...config.compilerOptions, strictNullChecks: false }
				})
			);
			expect(yield* diagnostics()).toEqual([]);
		}).pipe(Effect.provide(NodeServices.layer)),
	60_000
);
