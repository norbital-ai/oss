import { expect, it } from '@effect/vitest';
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { mount, unmount } from 'svelte';
import { page } from 'vitest/browser';
import Configuration from './support/system-configuration.svelte';
import type { Settings } from '../src/shell/settings/data.ts';
import type { Json } from '../src/decl/values.ts';
import type { SystemUiIntent } from '../src/protocol/system-ui.ts';
import type { InstanceStatus } from '../src/protocol/instance-status.ts';
import { shellApi, shellBolt } from '../src/shell/runtime.ts';
import './support/shell.css';

const settings: Settings = {
	members: [],
	teams: [],
	invitations: [],
	keys: [],
	policies: [],
	envoys: [],
	instances: [
		{
			id: 'erp',
			name: 'Fixture ERP',
			integration: 'erp',
			owner: null,
			named: false,
			envoy: null,
			active: true,
			status: { state: 'unpaired' },
			configuration: {},
			delivery: {
				sent: 0,
				pending: 0,
				retrying: 0,
				failed: 0,
				skipped: 0,
				nextRetry: null,
				lastError: null
			}
		}
	],
	secrets: [{ name: 'TOKEN', label: 'Fixture token', set: false }],
	mcp: [{ name: 'remote', url: 'TOKEN', secrets: ['TOKEN'] }],
	audit: [],
	integrations: [
		{
			name: 'erp',
			driver: 'http',
			description: 'Fixture ERP',
			conversation: false,
			personal: false,
			sends: false,
			syncs: false,
			configuration: {}
		}
	],
	signup: null
};
const nativeApi = shellApi(async () => Response.json({ value: [] }));

it.each(['secret', 'key', 'mcp', 'integration'] as const)(
	'a typed %s request opens the native form and waits for the person',
	async (kind) => {
		const runtime = ManagedRuntime.make(Layer.empty),
			dispose = mountEdge(runtime);
		const scope = Effect.runSync(Scope.make());
		const writes: { name: string; input: Readonly<Record<string, Json>> }[] = [];
		let paired = 0;
		const status: InstanceStatus = {
			instance: 'erp',
			integration: 'erp',
			driver: 'http',
			state: 'unpaired',
			stored: false,
			providers: [
				{
					id: 'http',
					label: 'HTTP',
					setup: {
						kind: 'form',
						steps: [],
						fields: [{ name: 'api_key', label: 'API key', secret: true }]
					}
				}
			]
		};
		const api = {
			...nativeApi,
			settings: () => Effect.succeed(settings),
			integration: (instance: string) => ({
				...nativeApi.integration(instance),
				status: () => Effect.succeed(status),
				watch: () => Stream.never,
				pair: () =>
					Effect.sync(() => {
						paired++;
						return status;
					})
			}),
			settingsOp: (name: string, input: Readonly<Record<string, Json>>) =>
				Effect.sync(() => {
					writes.push({ name, input });
					return name === 'issueKey' ? { key: 'synthetic-one-time-key' } : null;
				})
		};
		const bolt = await runtime.runPromise(
			shellBolt(
				{
					workspace: { name: 'Fixture', locale: 'en', tz: 'UTC' },
					actor: null,
					name: null,
					admin: true,
					preview: null,
					nav: [],
					inbox: 0,
					kiosks: [],
					push: null,
					visitor: null,
					automations: {},
					surfaces: { inbox: false, runs: false, settings: true, agent: false, studio: false },
					catalog: {
						sys_integration: {
							record_label: 'record.id',
							label: ['id'],
							fields: { id: { kind: 'text' }, revision: { kind: 'int' } }
						}
					}
				},
				{
					fetch: async () =>
						Response.json({ answers: [{ sys_integration: { rows: [], next: null, total: 0 } }] }),
					openStream: () => ({ onmessage: null, onerror: null, close() {} })
				}
			).pipe(Effect.provideService(Scope.Scope, scope))
		);
		const configuration: SystemUiIntent = {
			key: kind,
			request:
				kind === 'key'
					? { capability: 'api_key.create' }
					: kind === 'mcp'
						? { capability: 'mcp.configure', record: 'remote' }
						: kind === 'integration'
							? { capability: 'integration.manage', record: 'erp' }
							: { capability: 'secret.set', record: 'TOKEN' }
		};
		const target = document.createElement('div');
		document.body.replaceChildren(target);
		const view = mount(Configuration, {
			target,
			props: {
				api,
				bolt,
				t: (x: string) => x,
				tab: kind === 'secret' ? 'secrets' : 'integrations',
				workspace: { name: 'Fixture', locale: 'en', tz: 'UTC' },
				configuration
			}
		});
		try {
			if (kind === 'integration') {
				await expect.element(page.getByLabelText('API key')).toBeVisible();
				expect(paired).toBe(0);
				expect(writes).toEqual([]);
			} else if (kind === 'key') {
				await expect.element(page.getByLabelText('Key name')).toBeVisible();
				expect(writes).toEqual([]);
				await page.getByLabelText('Key name').fill('Fixture key');
				await page.getByRole('button', { name: 'Issue key', exact: true }).click();
				await expect
					.element(page.getByText('synthetic-one-time-key', { exact: true }))
					.toBeVisible();
				expect(writes).toEqual([{ name: 'issueKey', input: { name: 'Fixture key', team: null } }]);
			} else {
				if (kind === 'mcp')
					await page.getByRole('button', { name: 'Set TOKEN', exact: true }).click();
				await expect.element(page.getByLabelText('New value')).toBeVisible();
				expect(writes).toEqual([]);
				await page.getByLabelText('New value').fill('synthetic-user-input');
				await page.getByRole('button', { name: 'Set', exact: true }).click();
				await expect.element(page.getByLabelText('New value')).toHaveValue('');
				expect(writes).toEqual([
					{ name: 'setSecret', input: { name: 'TOKEN', value: 'synthetic-user-input' } }
				]);
			}
		} finally {
			await unmount(view);
			await runtime.runPromise(Scope.close(scope, Exit.void));
			await dispose();
			target.remove();
		}
	}
);

it('an invitation request opens the native invitation dialog without sending an invitation', async () => {
	const runtime = ManagedRuntime.make(Layer.empty),
		dispose = mountEdge(runtime);
	const scope = Effect.runSync(Scope.make());
	const bolt = await runtime.runPromise(
		shellBolt({
			workspace: { name: 'Fixture', locale: 'en', tz: 'UTC' },
			actor: null,
			name: null,
			admin: true,
			preview: null,
			nav: [],
			inbox: 0,
			kiosks: [],
			push: null,
			visitor: null,
			automations: {},
			catalog: {},
			surfaces: { inbox: false, runs: false, settings: true, agent: false, studio: false }
		}).pipe(Effect.provideService(Scope.Scope, scope))
	);
	let writes = 0;
	const api = {
		...nativeApi,
		settings: () => Effect.succeed(settings),
		settingsOp: () =>
			Effect.sync(() => {
				writes++;
				return null;
			})
	};
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const view = mount(Configuration, {
		target,
		props: {
			api,
			bolt,
			people: true,
			tab: 'organization',
			workspace: { name: 'Fixture', locale: 'en', tz: 'UTC' },
			t: (x: string) => x,
			configuration: { key: 'invite', request: { capability: 'member.invite' } }
		}
	});
	try {
		await expect.element(page.getByRole('dialog')).toBeVisible();
		expect(writes).toBe(0);
	} finally {
		await unmount(view);
		await runtime.runPromise(Scope.close(scope, Exit.void));
		await dispose();
		target.remove();
	}
});
