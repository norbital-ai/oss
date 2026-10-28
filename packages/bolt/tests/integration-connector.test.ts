// @vitest-environment happy-dom
// One connector row (the member's Connections, an envoy's channel): Connect makes the instance and starts pairing in the
// same click for a provider that pairs at once (the QR, the sign-in), reserving the sign-in window from that click; a
// provider the host cannot sign in is offered as unavailable; Disconnect asks in-app (never `window.confirm`, which
// WebViews suppress), unpairs, then removes the instance and shows it gone at once.
import './setup-happy-dom.js';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from '@effect/vitest';
import type { Json } from '../src/decl/values.ts';
import type { InstanceStatus, ProviderChoice } from '../src/protocol/instance-status.ts';
import type { IntegrationClient } from '../src/page/integrations.ts';
import Connector from '../src/shell/integration/Connector.svelte';

const views: (() => Promise<void>)[] = [];
let dispose: (() => Promise<void>) | undefined;
beforeEach(() => {
	dispose = mountEdge(ManagedRuntime.make(Layer.empty));
});
afterEach(async () => {
	for (const close of views.splice(0)) await close();
	await dispose?.();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
const settle = async () => {
	await tick();
	flushSync();
};

const GOOGLE: ProviderChoice = {
	id: 'google',
	label: 'Gmail (sign in with Google)',
	name: 'Gmail',
	setup: { kind: 'oauth', steps: [] }
};
const PASSWORD: ProviderChoice = {
	id: 'imap',
	label: 'Mail server',
	setup: { kind: 'form', steps: [], fields: [{ name: 'address', label: 'Address' }] }
};
const LINKED: ProviderChoice = {
	id: 'baileys',
	label: 'WhatsApp Web',
	name: 'WhatsApp',
	setup: { kind: 'qr', steps: [], fields: [{ name: 'phone', label: 'Phone', optional: true }] }
};

function show(props: {
	providers: readonly ProviderChoice[];
	instance?: { id: string; status: Json | null; active?: boolean } | null;
	connection?: Partial<InstanceStatus>;
}) {
	const calls: string[] = [];
	const paired: Json[] = [];
	const status = (instance: string): InstanceStatus => ({
		instance,
		integration: 'email',
		driver: 'email',
		state: 'unpaired',
		stored: false,
		providers: [...props.providers],
		...props.connection
	});
	const client = (instance: string): IntegrationClient => ({
		instance,
		status: () => Effect.succeed(status(instance)),
		pair: (input: Json = {}) =>
			Effect.sync(() => {
				calls.push(`pair ${instance}`);
				paired.push(input);
				return status(instance);
			}),
		unpair: () =>
			Effect.sync(() => {
				calls.push(`unpair ${instance}`);
				return status(instance);
			}),
		importStart: () => Effect.succeed(status(instance)),
		test: () => Effect.succeed(status(instance)),
		discover: () => Effect.succeed([]),
		watch: () => Stream.never
	});
	const target = document.body.appendChild(document.createElement('div'));
	const v = mount(Connector, {
		target,
		props: {
			driver: 'email',
			description: 'Your mailbox',
			providers: props.providers,
			instance: props.instance ?? null,
			client,
			create: () =>
				Effect.sync(() => {
					calls.push('create');
					return 'mine';
				}),
			remove: (instance: string) =>
				Effect.sync(() => {
					calls.push(`remove ${instance}`);
					return true;
				}),
			t: (k: string) => k,
			locale: 'en'
		}
	});
	views.push(async () => {
		await unmount(v);
		target.remove();
	});
	return { el: target, calls, paired };
}
const connect = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-connect]')!;
it('one click makes the instance and starts the sign-in, in a window reserved by that click', async () => {
	const reserved: string[] = [];
	vi.spyOn(window, 'open').mockImplementation((url) => {
		reserved.push(String(url));
		return null;
	});
	const { el, calls, paired } = show({ providers: [GOOGLE, PASSWORD] });
	await settle();
	connect(el).click();
	await vi.waitFor(() => expect(calls).toEqual(['create', 'pair mine']));
	expect(paired).toEqual([{ provider: 'google' }]);
	expect(reserved).toEqual(['']);
});

it('a provider the host cannot sign in cannot be connected', async () => {
	const { el, calls } = show({ providers: [{ ...GOOGLE, available: false }] });
	await settle();
	expect(connect(el).disabled).toBe(true);
	expect(calls).toEqual([]);
});

const dialog = () => document.querySelector<HTMLElement>('[data-confirm-dialog]');
const connected = () =>
	show({
		providers: [LINKED],
		instance: { id: 'phone', status: { state: 'connected', account: '6591234567' } },
		connection: { state: 'connected', stored: true, account: '6591234567' }
	});

it('Disconnect asks in-app, then unpairs and removes the instance; cancel leaves it alone', async () => {
	// a WebView answers `window.confirm` with false at once: the card must never depend on it
	const native = vi.fn(() => false);
	vi.stubGlobal('confirm', native);
	const { el, calls } = connected();
	await vi.waitFor(() => expect(el.querySelector('[data-disconnect]')).not.toBeNull());
	el.querySelector<HTMLButtonElement>('[data-disconnect]')!.click();
	await vi.waitFor(() => expect(dialog()).not.toBeNull());
	dialog()!.querySelector<HTMLButtonElement>('[data-confirm-cancel]')!.click();
	await settle();
	expect(calls).toEqual([]);
	el.querySelector<HTMLButtonElement>('[data-disconnect]')!.click();
	await vi.waitFor(() =>
		expect(document.querySelector('[data-confirm-dialog][data-state=open]')).not.toBeNull()
	);
	document
		.querySelector<HTMLElement>('[data-confirm-dialog][data-state=open] [data-confirm-accept]')!
		.click();
	await vi.waitFor(() => expect(calls).toEqual(['unpair phone', 'remove phone']));
	expect(native).not.toHaveBeenCalled();
});

it('cancelling before authentication unpairs and removes without a confirmation', async () => {
	const { el, calls } = show({
		providers: [LINKED],
		instance: { id: 'phone', status: { state: 'pairing' } },
		connection: { state: 'pairing', stored: true }
	});
	await vi.waitFor(() => expect(el.querySelector('[data-cancel-setup]')).not.toBeNull());
	el.querySelector<HTMLButtonElement>('[data-cancel-setup]')!.click();
	await vi.waitFor(() => expect(calls).toEqual(['unpair phone', 'remove phone']));
	expect(dialog()).toBeNull();
});
