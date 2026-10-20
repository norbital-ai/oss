import { expect, it } from '@effect/vitest';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import {
	IntegrationSetup,
	type IntegrationClient,
	type InstanceStatus
} from '../src/page/integration.ts';

it('the shared instance setup renders and pairs in Chromium without server-only imports', async () => {
	const dispose = mountEdge(ManagedRuntime.make(Layer.empty));
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
					fields: [{ name: 'apiKey', label: 'API key', secret: true }]
				}
			}
		]
	};
	const client: Pick<
		IntegrationClient,
		'instance' | 'status' | 'pair' | 'importStart' | 'unpair' | 'test' | 'watch'
	> = {
		instance: 'erp',
		status: () => Effect.sync(() => status),
		pair: () => Effect.sync(() => (status = { ...status, state: 'connected', stored: true })),
		importStart: () => Effect.sync(() => status),
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
