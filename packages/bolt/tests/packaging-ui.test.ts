import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect, vi } from 'vitest';
import { shell_api, shell_bolt } from '../src/shell/runtime.ts';

describe('page contexts', () => {
	it.effect('keeps each boot’s locale and messages separate', () =>
		Effect.gen(function* () {
			const boot = {
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
				catalog: {},
				automations: {},
				read_catalog: {},
				operation_outputs: { automations: {} }
			} satisfies Parameters<typeof shell_bolt>[0];
			const first = yield* shell_bolt(boot, { messages: { x: 'ms:x' } });
			const second = yield* shell_bolt(
				{ ...boot, workspace: { ...boot.workspace, locale: 'en' } },
				{ messages: { x: 'en:x' } }
			);
			expect(first.locale).toBe('ms');
			expect(first.t('x')).toBe('ms:x');
			expect(second.locale).toBe('en');
			expect(second.t('x')).toBe('en:x');
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
			const api = shell_api(async (input) => {
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
