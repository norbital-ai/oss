// @vitest-environment happy-dom
import { afterAll, beforeAll, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { Effect, Schema } from 'effect';
import type { ShellBoot } from '../src/shell/nav.ts';
import type { IntegrationSetupLoader } from '../src/page/integration.ts';
import type { InstanceStatus } from '../src/protocol/instance-status.ts';

// Mounted tests cover the UI; this verifies the scoped account transport and setup registry.
vi.mock('@norbital-ai/ui', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const meta = document.createElement('meta');
let shellBolt: (typeof import('../src/shell/runtime.ts'))['shellBolt'];
beforeAll(async () => {
	meta.name = 'bolt-base';
	meta.content = '/workspaces/hq';
	document.head.append(meta);
	({ shellBolt } = await import('../src/shell/runtime.ts'));
});
afterAll(() => meta.remove());

it.live(
	'uses the tenant path and configured authenticated transport for instance setup and pairing',
	() =>
		Effect.gen(function* () {
			const status: InstanceStatus = {
				instance: 'calendar/account',
				integration: 'calendar',
				driver: 'calendar',
				state: 'unpaired',
				stored: false,
				pairing: null
			};
			const requests: {
				path: string;
				method: string;
				body: unknown;
				credentials: RequestCredentials;
			}[] = [];
			const transport = vi.fn<typeof fetch>(async (input, init) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
				const request = new Request(new URL(url, 'https://workspace.test'), init);
				requests.push({
					path: new URL(request.url).pathname,
					method: request.method,
					body:
						request.body === null
							? null
							: Schema.decodeUnknownSync(Schema.Json)(await request.json()),
					credentials: request.credentials
				});
				return Response.json({ value: status });
			});
			const globalTransport = vi.fn<typeof fetch>(async () => {
				throw new Error('unscoped transport');
			});
			vi.stubGlobal('fetch', globalTransport);
			vi.stubGlobal('location', new URL('https://workspace.test/workspaces/hq/'));
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					vi.unstubAllGlobals();
				})
			);
			const boot: ShellBoot = {
				workspace: { name: 'HQ', locale: 'en', tz: 'UTC' },
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
			};
			const load: IntegrationSetupLoader = async () =>
				import('../src/page/IntegrationSetup.svelte');
			const bolt = yield* shellBolt(boot, {
				fetch: transport,
				integrationSetups: { calendar: { load } }
			});
			{
				expect(bolt.integrationSetup('calendar')).toBe(load);
				expect(bolt.integrationSetup('unknown')).toBeUndefined();
				const account = bolt.integration('calendar/account');
				expect(yield* account.status()).toEqual(status);
				yield* account.pair({ provider: 'google' });
				yield* account.importStart({ kind: 'since', date: '2026-10-21', zone: 'Asia/Singapore' });
				expect(requests[0]).toEqual({
					path: '/workspaces/hq/__bolt/integrations/calendar%2Faccount',
					method: 'GET',
					body: null,
					credentials: 'same-origin'
				});
				expect(requests[1]).toEqual({
					path: '/workspaces/hq/__bolt/integrations/calendar%2Faccount/pair',
					method: 'POST',
					body: { provider: 'google' },
					credentials: 'same-origin'
				});
				expect(globalTransport).not.toHaveBeenCalled();
				expect(requests[2]).toEqual({
					path: '/workspaces/hq/__bolt/integrations/calendar%2Faccount/import-start',
					method: 'POST',
					body: { kind: 'since', date: '2026-10-21', zone: 'Asia/Singapore' },
					credentials: 'same-origin'
				});
			}
		})
);
