// @vitest-environment happy-dom
// Connection card FSM and UI: every state (Not yet installed → Not connected → Connecting/Pairing →
// Connected → Disconnected → Error / Paused) renders its status badge and dynamic CTA button;
// Install creates the record without dumping raw forms; Connect opens setup in a Sheet (or reserves
// OAuth for a single one-click OAuth provider); Disconnect confirms in-app and transitions to Disconnected;
// Uninstall confirms in-app and returns to Not yet installed.
import { required } from './support/required.ts';
import './setup-happy-dom.js';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from '@effect/vitest';
import type { Json } from '../src/decl/values.ts';
import type { InstanceStatus, ProviderChoice } from '@norbital-ai/host-api';
import type { IntegrationClient } from '../src/page/integrations.ts';
import IntegrationCard from '../src/page/IntegrationCard.svelte';
import { resolveConnectionState } from '../src/page/connection-fsm.ts';

const views: (() => Promise<void>)[] = [];
let dispose: (() => Promise<void>) | undefined;
beforeEach(() => {
	dispose = mount_edge(ManagedRuntime.make(Layer.empty));
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
	presentation?: 'sheet' | 'inline';
	withDelete?: boolean;
}) {
	const calls: string[] = [];
	const paired: Json[] = [];
	let current: Partial<InstanceStatus> = { ...props.connection };
	const status = (instance: string): InstanceStatus => ({
		instance,
		integration: 'email',
		driver: 'email',
		state: 'unpaired',
		stored: false,
		providers: [...props.providers],
		...current
	});
	const client = (instance: string): IntegrationClient => ({
		instance,
		status: () => Effect.sync(() => status(instance)),
		pair: (input: Json = {}) =>
			Effect.sync(() => {
				calls.push(`pair ${instance}`);
				paired.push(input);
				return status(instance);
			}),
		unpair: () =>
			Effect.sync(() => {
				calls.push(`unpair ${instance}`);
				const wasConnected = current.state === 'connected';
				current = { ...current, state: 'unpaired', stored: false, account: null, ...(wasConnected ? { code: 'disconnected' } : {}) };
				return status(instance);
			}),
		import_start: () => Effect.sync(() => status(instance)),
		test: () => Effect.sync(() => status(instance)),
		discover: () => Effect.succeed([]),
		threads: () => Effect.succeed({ groups: [], dms: [] }),
		watch: () => Stream.never
	});
	const target = document.body.appendChild(document.createElement('div'));
	const v = mount(IntegrationCard, {
		target,
		props: {
			driver: 'email',
			description: 'Your mailbox',
			providers: props.providers,
			instance: props.instance ?? null,
			client,
			presentation: props.presentation ?? 'sheet',
			create: () =>
				Effect.sync(() => {
					calls.push('create');
					return 'mine';
				}),
			...(props.withDelete
				? {
						on_delete: () =>
							Effect.sync(() => {
								calls.push('delete');
							})
					}
				: {}),
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

const cta = (el: HTMLElement) =>
	required(el.querySelector<HTMLButtonElement>('[data-connector-action]'));
const phase = (el: HTMLElement) =>
	required(el.querySelector<HTMLElement>('[data-connector-phase]')).getAttribute('data-connector-phase');
const dialog = () => document.querySelector<HTMLElement>('[data-confirm-dialog]');

it('resolves every connection FSM phase and CTA label deterministically', () => {
	expect(resolveConnectionState({ installed: false, status: null })).toMatchObject({
		phase: 'not_installed',
		label: 'Not yet installed',
		cta: { action: 'install', label: 'Install' }
	});
	expect(resolveConnectionState({ installed: true, status: null })).toMatchObject({
		phase: 'not_connected',
		label: 'Not connected',
		cta: { action: 'connect', label: 'Connect' }
	});
	expect(
		resolveConnectionState({
			installed: true,
			status: { instance: 'a', integration: 'whatsapp', driver: 'whatsapp', state: 'pairing', stored: false }
		})
	).toMatchObject({
		phase: 'connecting',
		label: 'Pairing',
		cta: { action: 'continue', label: 'Continue setup' }
	});
	expect(
		resolveConnectionState({
			installed: true,
			setupOpen: true,
			status: { instance: 'a', integration: 'whatsapp', driver: 'whatsapp', state: 'pairing', stored: false }
		})
	).toMatchObject({
		phase: 'connecting',
		cta: { action: 'cancel', label: 'Cancel' }
	});
	expect(
		resolveConnectionState({
			installed: true,
			status: { instance: 'a', integration: 'whatsapp', driver: 'whatsapp', state: 'connected', stored: true, account: '+6591234567' }
		})
	).toMatchObject({
		phase: 'connected',
		label: 'Connected',
		account: '+6591234567',
		cta: { action: 'disconnect', label: 'Disconnect' }
	});
	expect(
		resolveConnectionState({
			installed: true,
			status: { instance: 'a', integration: 'whatsapp', driver: 'whatsapp', state: 'unpaired', code: 'disconnected', stored: false }
		})
	).toMatchObject({
		phase: 'disconnected',
		label: 'Disconnected',
		cta: { action: 'reconnect', label: 'Reconnect' }
	});
	expect(
		resolveConnectionState({
			installed: true,
			status: { instance: 'a', integration: 'whatsapp', driver: 'whatsapp', state: 'error', error: 'Logged out', stored: false }
		})
	).toMatchObject({
		phase: 'error',
		label: 'Error',
		detail: 'Logged out',
		cta: { action: 'retry', label: 'Retry' }
	});
	expect(
		resolveConnectionState({
			installed: true,
			active: false,
			canResume: true,
			status: null
		})
	).toMatchObject({
		phase: 'paused',
		label: 'Paused',
		cta: { action: 'resume', label: 'Resume' }
	});
});

it('transitions Not yet installed → Not connected on Install and opens the setup sheet directly', async () => {
	const { el, calls } = show({ providers: [GOOGLE, PASSWORD] });
	await settle();
	expect(phase(el)).toBe('not_installed');
	expect(cta(el).textContent?.trim()).toBe('Install');
	cta(el).click();
	await vi.waitFor(() => expect(calls).toEqual(['create']));
	await vi.waitFor(() => expect(phase(el)).toBe('not_connected'));
	expect(cta(el).textContent?.trim()).toBe('Connect');
	await vi.waitFor(() => expect(document.querySelector('[data-connector-panel="pair"]')).not.toBeNull());
});

it('a single one-click OAuth provider reserves the sign-in window and starts pairing on Connect', async () => {
	const reserved: string[] = [];
	vi.spyOn(window, 'open').mockImplementation((url) => {
		reserved.push(String(url));
		return null;
	});
	const { el, calls, paired } = show({
		providers: [GOOGLE],
		instance: { id: 'mine', status: { state: 'unpaired' } },
		connection: { state: 'unpaired' }
	});
	await settle();
	expect(phase(el)).toBe('not_connected');
	cta(el).click();
	await vi.waitFor(() => expect(calls).toEqual(['pair mine']));
	expect(paired).toEqual([{}]);
	expect(reserved).toEqual(['']);
});

it('a provider the host cannot sign in cannot be installed or connected', async () => {
	const { el, calls } = show({ providers: [{ ...GOOGLE, available: false }] });
	await settle();
	expect(cta(el).disabled).toBe(true);
	expect(el.textContent).toContain('Not available on this host');
	expect(calls).toEqual([]);
});

it('Disconnect confirms in-app, unpairs, and transitions Connected → Disconnected with Reconnect CTA', async () => {
	const native = vi.fn(() => false);
	vi.stubGlobal('confirm', native);
	const { el, calls } = show({
		providers: [LINKED],
		instance: { id: 'phone', status: { state: 'connected', account: '6591234567' } },
		connection: { state: 'connected', stored: true, account: '6591234567' }
	});
	await vi.waitFor(() => expect(phase(el)).toBe('connected'));
	expect(cta(el).textContent?.trim()).toBe('Disconnect');
	cta(el).click();
	await vi.waitFor(() => expect(dialog()).not.toBeNull());
	required(required(dialog()).querySelector<HTMLButtonElement>('[data-confirm-cancel]')).click();
	await settle();
	expect(calls).toEqual([]);
	expect(phase(el)).toBe('connected');

	cta(el).click();
	await vi.waitFor(() =>
		expect(document.querySelector('[data-confirm-dialog][data-state=open]')).not.toBeNull()
	);
	required(
		document.querySelector<HTMLElement>('[data-confirm-dialog][data-state=open] [data-confirm-accept]')
	).click();
	await vi.waitFor(() => expect(calls).toEqual(['unpair phone']));
	await vi.waitFor(() => expect(phase(el)).toBe('disconnected'));
	expect(cta(el).textContent?.trim()).toBe('Reconnect');
	expect(native).not.toHaveBeenCalled();
});

it('cancelling while pairing unpairs without confirmation', async () => {
	const { el, calls } = show({
		providers: [LINKED],
		instance: { id: 'phone', status: { state: 'pairing' } },
		connection: { state: 'pairing', stored: true },
		presentation: 'inline'
	});
	await vi.waitFor(() => expect(phase(el)).toBe('connecting'));
	// Open setup panel first, then Cancel
	cta(el).click();
	await settle();
	expect(cta(el).textContent?.trim()).toBe('Cancel');
	cta(el).click();
	await vi.waitFor(() => expect(calls).toEqual(['unpair phone']));
	expect(dialog()).toBeNull();
});

it('Uninstall confirms in-app and deletes the record, returning to Not yet installed', async () => {
	const { el, calls } = show({
		providers: [LINKED],
		instance: { id: 'phone', status: { state: 'unpaired' } },
		connection: { state: 'unpaired', stored: false },
		presentation: 'inline',
		withDelete: true
	});
	await vi.waitFor(() => expect(phase(el)).toBe('not_connected'));
	required(el.querySelector<HTMLButtonElement>('[data-manage]')).click();
	await settle();
	required(el.querySelector<HTMLButtonElement>('[data-uninstall]')).click();
	await vi.waitFor(() =>
		expect(document.querySelector('[data-confirm-dialog][data-state=open]')).not.toBeNull()
	);
	required(
		document.querySelector<HTMLElement>('[data-confirm-dialog][data-state=open] [data-confirm-accept]')
	).click();
	await vi.waitFor(() => expect(calls).toEqual(['delete']));
});
