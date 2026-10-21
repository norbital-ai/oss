// @vitest-environment happy-dom
// The generic setup of one integration instance (`IntegrationSetup`) over its client: the status read and stream, the
// provider's form with its secrets masked and cleared, pairing, the connected summary, disconnecting, a refused read
// shown as such, and nothing drawn after unmount.
import { flushSync, mount, tick, unmount } from 'svelte';
import { beforeEach, afterEach, expect, it, vi } from '@effect/vitest';
import './setup-happy-dom.ts';
import { Deferred, Effect, Layer, ManagedRuntime, Queue, Stream } from 'effect';
import { mountEdge, run } from '@norbital-ai/ui/effect';
import { ActRefused, ProtocolFailed } from '../src/decl/errors.ts';
import type { Json } from '../src/decl/values.ts';
import IntegrationSetup from '../src/page/IntegrationSetup.svelte';
import type { IntegrationClient } from '../src/page/integrations.ts';
import type { InstanceStatus } from '../src/protocol/instance-status.ts';
import { reactive } from './support/reactive.svelte.ts';

const mounted: (() => Promise<void>)[] = [];
let dispose: (() => Promise<void>) | undefined;
beforeEach(() => {
	dispose = mountEdge(ManagedRuntime.make(Layer.empty));
});
afterEach(async () => {
	for (const close of mounted.splice(0)) await close();
	document.body.replaceChildren();
	await dispose?.();
});
const settle = async () => {
	await tick();
	flushSync();
};
type Client = Pick<
	IntegrationClient,
	'instance' | 'status' | 'pair' | 'importStart' | 'unpair' | 'test' | 'watch'
>;
const fixture = (over: Partial<Client> = {}) => {
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
					steps: [{ text: 'Paste the key the ERP issued.' }],
					fields: [{ name: 'apiKey', label: 'API key', secret: true }]
				}
			}
		]
	};
	let push: ((s: InstanceStatus) => void) | undefined;
	const watching = Deferred.makeUnsafe<void>(),
		pairing = Deferred.makeUnsafe<void>(),
		unpairing = Deferred.makeUnsafe<void>();
	const off = vi.fn();
	const pair = vi.fn((_input: Json = {}) =>
		Effect.sync(() => {
			status = { ...status, state: 'connected', stored: true, account: 'Operations' };
			Deferred.doneUnsafe(pairing, Effect.void);
			return status;
		})
	);
	const unpair = vi.fn(() =>
		Effect.sync(() => {
			status = { ...status, state: 'unpaired', stored: false };
			Deferred.doneUnsafe(unpairing, Effect.void);
			return status;
		})
	);
	const client: Client = {
		instance: 'erp',
		status: () => Effect.sync(() => status),
		pair,
		importStart: () => Effect.sync(() => status),
		unpair,
		test: () => Effect.sync(() => status),
		watch: () =>
			Stream.callback((queue) =>
				Effect.acquireRelease(
					Effect.sync(() => {
						push = (value) => {
							Queue.offerUnsafe(queue, value);
						};
						Deferred.doneUnsafe(watching, Effect.void);
					}),
					() =>
						Effect.sync(() => {
							off();
						})
				)
			),
		...over
	};
	return {
		client,
		pair,
		unpair,
		off,
		ready: Deferred.await(watching),
		paired: Deferred.await(pairing),
		unpaired: Deferred.await(unpairing),
		push: (s: Partial<InstanceStatus>) => push?.({ ...status, ...s })
	};
};
const show = async (client: Client, ready: Effect.Effect<void> = Effect.void) => {
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(IntegrationSetup, { target, props: { client } });
	mounted.push(async () => {
		await unmount(view);
		target.remove();
	});
	await run(ready);
	await settle();
	return target;
};
/** The in-app confirmation's accept button, once it is open. */
const accept = async () => {
	const open = '[data-confirm-dialog][data-state=open] [data-confirm-accept]';
	await vi.waitFor(() => expect(document.querySelector(open)).not.toBeNull());
	document.querySelector<HTMLButtonElement>(open)!.click();
};
const button = (target: HTMLElement, text: string) => {
	const found = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
	if (!found) throw new Error(`button '${text}' not found`);
	return found;
};

it('draws the provider’s form masked, pairs with what it collected, clears the secret, then shows the connected summary and disconnects', async () => {
	const f = fixture(),
		target = await show(f.client, f.ready);
	await vi.waitFor(() => expect(target.querySelector('[data-setup-form] input')).not.toBeNull());
	const input = target.querySelector<HTMLInputElement>('[data-setup-form] input');
	if (input === null) throw new Error('Missing provider API-key field');
	expect(input.type).toBe('password');
	input.value = 'private-key';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	target.querySelector<HTMLFormElement>('[data-setup-form]')!.requestSubmit();
	await run(f.paired);
	expect(f.pair).toHaveBeenCalledWith({ apiKey: 'private-key' });
	await vi.waitFor(() =>
		expect(target.querySelector('[data-connection-state]')!.textContent).toBe(
			'Connected as {as}'.replace('{as}', 'Operations')
		)
	);
	expect(target.textContent).not.toContain('private-key');
	button(target, 'Disconnect').click();
	await accept();
	await run(f.unpaired);
	expect(f.unpair).toHaveBeenCalledOnce();
	await vi.waitFor(() => expect(target.querySelector('[data-setup-view=pair]')).not.toBeNull());
});

it('follows the status stream: a QR the provider publishes while pairing replaces the form', async () => {
	const f = fixture(),
		target = await show(f.client, f.ready);
	await vi.waitFor(() => expect(target.querySelector('[data-setup-form] input')).not.toBeNull());
	f.push({ state: 'pairing', pairing: { kind: 'code', value: 'ABCD-1234' } });
	await vi.waitFor(() =>
		expect(target.querySelector('[data-pairing=code] code')?.textContent).toBe('ABCD-1234')
	);
	expect(target.querySelector('[data-setup-form]')).toBeNull();
});

it('shows a refused read as such, and the host’s refusal of a pairing verbatim', async () => {
	const refused = await show(
		fixture({ status: () => Effect.fail(new ProtocolFailed({ message: 'forbidden' })) }).client
	);
	await vi.waitFor(() =>
		expect(refused.querySelector('[role="alert"]')?.textContent).toContain('Check access')
	);
	const f = fixture({
			pair: () =>
				Effect.fail(new ActRefused({ code: 'refused', message: 'The API key is not valid (401).' }))
		}),
		target = await show(f.client, f.ready);
	await vi.waitFor(() => expect(target.querySelector('[data-setup-form] input')).not.toBeNull());
	const input = target.querySelector<HTMLInputElement>('[data-setup-form] input');
	if (input === null) throw new Error('Missing provider API-key field');
	input.value = 'bad';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	target.querySelector<HTMLFormElement>('[data-setup-form]')!.requestSubmit();
	await vi.waitFor(() =>
		expect(target.querySelector('[data-connection-error]')?.textContent).toBe(
			'The API key is not valid (401).'
		)
	);
});

it('retains a refused import edit and never reports it as saved after another request succeeds', async () => {
	const status: InstanceStatus = {
		instance: 'erp',
		integration: 'erp',
		driver: 'http',
		state: 'connected',
		stored: true,
		providers: [
			{
				id: 'http',
				label: 'HTTP',
				setup: { kind: 'form', steps: [] },
				importStart: { kind: 'timestamp' }
			}
		]
	};
	const f = fixture({
		status: () => Effect.succeed(status),
		importStart: () =>
			Effect.fail(new ActRefused({ code: 'refused', message: 'Import start could not be saved.' })),
		test: () => Effect.succeed(status)
	});
	const target = await show(f.client, f.ready);
	target.querySelector<HTMLButtonElement>('[role=combobox][aria-label="Import start"]')!.click();
	await settle();
	document.querySelector<HTMLButtonElement>('[role=option][data-value=since] button')!.click();
	await settle();
	const date = target.querySelector<HTMLInputElement>('input[name=import-start-date]')!;
	date.value = '2026-10-21';
	date.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
	target.querySelector<HTMLFormElement>('[data-import-start-form]')!.requestSubmit();
	await vi.waitFor(() =>
		expect(target.querySelector('[data-connection-error]')?.textContent).toContain(
			'could not be saved'
		)
	);
	expect(date.value).toBe('2026-10-21');
	button(target, 'Test connection').click();
	await vi.waitFor(() => expect(target.querySelector('[data-connection-error]')).toBeNull());
	expect(target.textContent).not.toContain('Import start updated');
	expect(button(target, 'Apply import start').disabled).toBe(false);
});

it('unsubscribes its stream on unmount and draws nothing a late read answers', async () => {
	let complete: ((s: InstanceStatus) => void) | undefined;
	const f = fixture();
	const requested = Deferred.makeUnsafe<void>();
	const target = await show(
		{
			...f.client,
			status: () =>
				Effect.callback((resume) => {
					complete = (value) => resume(Effect.succeed(value));
					Deferred.doneUnsafe(requested, Effect.void);
				})
		},
		f.ready
	);
	await run(Deferred.await(requested));
	expect(
		target.querySelector('[data-connection-state]')!.getAttribute('data-connection-state')
	).toBe('loading');
	const close = mounted.pop();
	if (close === undefined) throw new Error('Missing mounted view');
	await close();
	await vi.waitFor(() => expect(f.off).toHaveBeenCalledOnce());
	expect(f.off).toHaveBeenCalledOnce();
	complete?.(await run(f.client.status()));
	await settle();
	expect(document.querySelector('[data-connection-state]')).toBeNull();
});

it('does not let an obsolete mutation replace the new client status or clear its busy state', async () => {
	const oldAnswer = Deferred.makeUnsafe<InstanceStatus>(),
		newAnswer = Deferred.makeUnsafe<InstanceStatus>();
	const oldStarted = Deferred.makeUnsafe<void>(),
		newStarted = Deferred.makeUnsafe<void>(),
		oldFinished = Deferred.makeUnsafe<void>();
	const oldClient = fixture({
		pair: () =>
			Deferred.succeed(oldStarted, undefined).pipe(
				Effect.andThen(Deferred.await(oldAnswer)),
				Effect.ensuring(Deferred.succeed(oldFinished, undefined))
			)
	});
	const nextClient = fixture({
		pair: () =>
			Deferred.succeed(newStarted, undefined).pipe(Effect.andThen(Deferred.await(newAnswer)))
	});
	const selected = reactive<{ client: Client }>({ client: oldClient.client });
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(IntegrationSetup, {
		target,
		props: {
			get client() {
				return selected.client;
			}
		}
	});
	mounted.push(async () => {
		await unmount(view);
		target.remove();
	});
	const connect = async () => {
		await vi.waitFor(() => expect(target.querySelector('[data-setup-form] input')).not.toBeNull());
		const input = target.querySelector<HTMLInputElement>('[data-setup-form] input');
		const form = target.querySelector<HTMLFormElement>('[data-setup-form]');
		if (input === null || form === null) throw new Error('Missing integration pairing form');
		input.value = 'fixture-key';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		form.requestSubmit();
	};
	await run(oldClient.ready);
	await connect();
	await run(Deferred.await(oldStarted));
	selected.client = nextClient.client;
	await run(nextClient.ready);
	await settle();
	await connect();
	await run(Deferred.await(newStarted));
	const initial = await run(nextClient.client.status());
	await run(
		Deferred.succeed(oldAnswer, {
			...initial,
			state: 'connected',
			stored: true,
			account: 'Obsolete account'
		})
	);
	await run(Deferred.await(oldFinished));
	await settle();
	expect(target.textContent).not.toContain('Obsolete account');
	const submit = target.querySelector<HTMLButtonElement>('[data-setup-form] button[type=submit]');
	if (submit === null) throw new Error('Current pairing form disappeared');
	expect(submit.disabled).toBe(true);
	await run(
		Deferred.succeed(newAnswer, {
			...initial,
			state: 'connected',
			stored: true,
			account: 'Current account'
		})
	);
	await vi.waitFor(() =>
		expect(target.querySelector('[data-connection-state]')?.textContent).toContain(
			'Current account'
		)
	);
	nextClient.push({ state: 'unpaired', stored: false });
	await vi.waitFor(() => expect(target.querySelector('[data-setup-form]')).not.toBeNull());
});
