import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { describe, expect, vi } from 'vitest';
import { bolt as shellClient, setCurrentBolt, shellApi, shellBolt } from '../src/shell/runtime.ts';

class ImportFailure extends Schema.TaggedError<ImportFailure>()('ImportFailure', {
	cause: Schema.Defect()
}) {}
describe('$bolt', () => {
	it.effect('imports before the shell boots and reads the booted client on use', () =>
		Effect.gen(function* () {
			setCurrentBolt(null);
			const { bolt } = yield* Effect.tryPromise({
				try: () => import('../src/page/index.ts'),
				catch: (cause) => new ImportFailure({ cause })
			});
			expect(() => bolt.locale).toThrow('before the workspace shell booted');
			const client = yield* shellBolt(
				{
					workspace: { name: 'Fixture', locale: 'ms', tz: 'UTC' },
					actor: null,
					name: null,
					admin: false,
					preview: null,
					nav: [],
					surfaces: { inbox: false, runs: false, settings: false, agent: false, studio: false },
					inbox: 0,
					kiosks: [],
					push: null,
					visitor: null,
					catalog: {}
				},
				{ messages: { x: 'ms:x' } }
			);
			setCurrentBolt(client);
			yield* Effect.addFinalizer(() => Effect.sync(() => setCurrentBolt(null)));
			expect(bolt.locale).toBe('ms');
			expect(bolt.t).toBe(shellClient.t);
			expect(shellClient.t('x')).toBe('ms:x');
		})
	);
});
describe('bolt.runs', () => {
	it.effect("lists one automation's runs up to the limit", () =>
		Effect.gen(function* () {
			const urls: string[] = [];
			vi.stubGlobal('location', new URL('https://workspace.test/'));
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					vi.unstubAllGlobals();
				})
			);
			const api = shellApi(async (input) => {
				urls.push(String(input));
				return new Response(JSON.stringify({ value: [] }));
			});
			yield* api.runs({ automation: 'payroll_export', limit: 5 });
			expect(urls).toEqual([
				'https://workspace.test/__bolt/shell/runs?automation=payroll_export&limit=5'
			]);
		})
	);
});
