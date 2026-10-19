// @vitest-environment happy-dom
// One connector row (the member's Connections, an envoy's channel): Connect makes the instance and starts pairing in the
// same click for a provider that pairs at once (the QR, the sign-in), reserving the sign-in window from that click; a
// provider the host cannot sign in is offered as unavailable; Disconnect unpairs, then removes the instance.
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
	instance?: { id: string; status: Json | null } | null;
}) {
	const calls: string[] = [];
	const paired: Json[] = [];
	const status = (instance: string): InstanceStatus => ({
		instance,
		integration: 'email',
		driver: 'email',
		state: 'unpaired',
		stored: false,
		providers: [...props.providers]
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
	expect(el.textContent).toContain('Gmail');
	connect(el).click();
	await vi.waitFor(() => expect(calls).toEqual(['create', 'pair mine']));
	expect(paired).toEqual([{ provider: 'google' }]);
	expect(reserved).toEqual(['']);
	await settle();
	expect(el.querySelector('[data-setup-view]')).not.toBeNull(); // the setup opens beneath the row
});

it('a QR provider pairs at once: no field stands before its code', async () => {
	const { el, calls, paired } = show({ providers: [LINKED] });
	await settle();
	connect(el).click();
	await vi.waitFor(() => expect(calls).toEqual(['create', 'pair mine']));
	expect(paired).toEqual([{}]);
});

it('a provider the host cannot sign in is unavailable; the other ways stay offered', async () => {
	const { el, calls } = show({ providers: [{ ...GOOGLE, available: false }] });
	await settle();
	expect(connect(el).disabled).toBe(true);
	expect(el.textContent).toContain('Not available on this host');
	expect(calls).toEqual([]);
	const other = show({ providers: [{ ...GOOGLE, available: false }, PASSWORD] });
	await settle();
	// the one-click way stays Google's (disabled here); the password way is behind "Other ways to connect"
	expect(connect(other.el).disabled).toBe(true);
	[...other.el.querySelectorAll('button')]
		.find((b) => b.textContent === 'Other ways to connect')!
		.click();
	// a form provider: the instance is made and its setup opens, nothing is paired yet
	await vi.waitFor(() => expect(other.calls).toEqual(['create']));
});

it('Disconnect unpairs the instance, then removes it', async () => {
	vi.stubGlobal('confirm', () => true);
	const { el, calls } = show({
		providers: [LINKED],
		instance: { id: 'phone', status: { state: 'connected', account: '6591234567' } }
	});
	await settle();
	expect(el.textContent).toContain('Connected as 6591234567');
	expect(el.querySelector('[data-connect]')).toBeNull();
	el.querySelector<HTMLButtonElement>('[data-disconnect]')!.click();
	await vi.waitFor(() => expect(calls).toEqual(['unpair phone', 'remove phone']));
});
