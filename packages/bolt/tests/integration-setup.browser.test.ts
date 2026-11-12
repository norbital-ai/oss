import { expect, it } from '@effect/vitest';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import { IntegrationSetup } from '../src/page/index.ts';
import type { InstanceStatus } from '../src/protocol/instance-status.ts';
import type { IntegrationClient } from '../src/page/integrations.ts';

it('the shared instance setup renders and pairs in Chromium without server-only imports', async () => {
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	document.body.replaceChildren();
	const target = document.createElement('div');
	document.body.append(target);
	let status: InstanceStatus = {
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
	const client: Pick<
		IntegrationClient,
		'instance' | 'status' | 'pair' | 'import_start' | 'unpair' | 'test' | 'watch'
	> = {
		instance: 'erp',
		status: () => Effect.sync(() => status),
		pair: () => Effect.sync(() => (status = { ...status, state: 'connected', stored: true })),
		import_start: () => Effect.sync(() => status),
		unpair: () => Effect.sync(() => status),
		test: () => Effect.sync(() => status),
		watch: () => Stream.never
	};
	const view = mount(IntegrationSetup, { target, props: { client } });
	try {
		await expect.element(page.getByLabelText('API key')).toBeInTheDocument();
		await page.getByLabelText('API key').fill('fixture-secret');
		await page.getByRole('button', { name: 'Connect', exact: true }).click();
		await expect.element(page.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
		await expect.element(page.getByText('fixture-secret')).not.toBeInTheDocument();
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
	}
});
