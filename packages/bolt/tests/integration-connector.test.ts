// @vitest-environment happy-dom
// One connector row (the member's Connections, an envoy's channel): Connect makes the instance and starts pairing in the
// same click for a provider that pairs at once (the QR, the sign-in), reserving the sign-in window from that click; a
// provider the host cannot sign in is offered as unavailable; Disconnect asks in-app (never `window.confirm`, which
// WebViews suppress), unpairs, then removes the instance and shows it gone at once.
import './setup-happy-dom.js';
import { Deferred, Effect, Layer, ManagedRuntime, Queue, Stream } from 'effect';
import { mountEdge, run } from '@norbital-ai/ui/effect';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from '@effect/vitest';
import type { Json } from '../src/decl/values.ts';
import type {
	ImportStartInput,
	InstanceStatus,
	ProviderChoice
} from '../src/protocol/instance-status.ts';
import type { IntegrationClient } from '../src/page/integrations.ts';
import Connector from '../src/shell/integration/Connector.svelte';
import { reactive } from './support/reactive.svelte.ts';

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
	onManage?: (instance: string) => void;
	connection?: Partial<InstanceStatus> | undefined;
	loading?: boolean;
}) {
	const calls: string[] = [];
	const paired: Json[] = [];
	const boundaries: ImportStartInput[] = [];
	const state = reactive({ instance: props.instance ?? null });
	let current = props.connection ?? {};
	let publish: ((value: InstanceStatus) => void) | undefined;
	const watching = Deferred.makeUnsafe<void>();
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
		status: () => (props.loading ? Effect.never : Effect.succeed(status(instance))),
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
		importStart: (input) =>
			Effect.sync(() => {
				calls.push(`import-start ${instance}`);
				boundaries.push(input);
				return status(instance);
			}),
		test: () => Effect.succeed(status(instance)),
		discover: () => Effect.succeed([]),
		watch: () =>
			Stream.callback((queue) =>
				Effect.sync(() => {
					publish = (value) => {
						Queue.offerUnsafe(queue, value);
					};
					Deferred.doneUnsafe(watching, Effect.void);
				})
			)
	});
	const target = document.body.appendChild(document.createElement('div'));
	const v = mount(Connector, {
		target,
		props: {
			driver: 'email',
			description: 'Your mailbox',
			providers: props.providers,
			get instance() {
				return state.instance;
			},
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
			onManage: props.onManage,
			t: (k: string) => k,
			locale: 'en'
		}
	});
	views.push(async () => {
		await unmount(v);
		target.remove();
	});
	return {
		el: target,
		calls,
		paired,
		boundaries,
		state,
		ready: () => run(Deferred.await(watching)),
		publish: (next: Partial<InstanceStatus>) => {
			current = { ...current, ...next };
			publish?.(status(state.instance?.id ?? 'mine'));
		}
	};
}
const connect = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-connect]')!;
const type = (input: HTMLInputElement, value: string) => {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
};
const chooseImport = async (el: HTMLElement, kind: string) => {
	el.querySelector<HTMLButtonElement>('[role=combobox][aria-label="Import start"]')!.click();
	await settle();
	document.querySelector<HTMLButtonElement>(`[role=option][data-value=${kind}] button`)!.click();
	await settle();
};

it('offers From now before a new connection and saves the explicit zone atomically with pairing', async () => {
	vi.spyOn(window, 'open').mockReturnValue(null);
	const f = show({
		providers: [{ ...GOOGLE, importStart: { kind: 'timestamp', precision: 'second' } }]
	});
	await settle();
	expect(f.el.querySelector('[data-import-start]')?.textContent).toContain('From now');
	expect(f.el.querySelector('[data-import-start-precision]')?.textContent).toContain(
		'the whole starting second is included'
	);
	expect(f.el.textContent).not.toContain('The host saves the current instant');
	expect(f.calls).toEqual([]);
	type(f.el.querySelector<HTMLInputElement>('input[name=import-start-zone]')!, 'Asia/Singapore');
	await settle();
	connect(f.el).click();
	await vi.waitFor(() => expect(f.calls).toEqual(['create', 'pair mine']));
	expect(f.paired).toEqual([{ importStart: { kind: 'now', zone: 'Asia/Singapore' } }]);
});

it('discloses the whole starting second for a saved From now boundary, while date boundaries stay exact', async () => {
	const f = show({
		providers: [{ ...GOOGLE, importStart: { kind: 'timestamp', precision: 'second' } }],
		instance: { id: 'mail', status: { state: 'connected' } },
		connection: {
			state: 'connected',
			stored: true,
			importStart: {
				kind: 'since',
				at: '2026-10-20T16:00:00.000Z',
				zone: 'Asia/Singapore',
				origin: 'now'
			}
		}
	});
	await f.ready();
	await vi.waitFor(() =>
		expect(f.el.querySelector('[data-import-start-active]')?.textContent).toContain(
			'00:00:00 (Asia/Singapore)'
		)
	);
	expect(f.el.querySelector('[data-import-start-precision]')?.textContent).toContain(
		'the whole starting second is included'
	);
	expect(f.calls).toEqual([]);
	f.publish({
		importStart: {
			kind: 'since',
			at: '2026-10-20T16:00:00.000Z',
			zone: 'Asia/Singapore',
			origin: 'date'
		}
	});
	await vi.waitFor(() => expect(f.el.querySelector('[data-import-start-precision]')).toBeNull());
	expect(f.el.querySelector('[data-import-start-active]')?.textContent).toContain(
		'00:00:00 (Asia/Singapore)'
	);
});

it('sends a chosen civil date and zone before pairing, without converting the date in the browser', async () => {
	vi.spyOn(window, 'open').mockReturnValue(null);
	const f = show({ providers: [{ ...GOOGLE, importStart: { kind: 'timestamp' } }] });
	await settle();
	await chooseImport(f.el, 'since');
	type(f.el.querySelector<HTMLInputElement>('input[name=import-start-date]')!, '2026-10-21');
	type(f.el.querySelector<HTMLInputElement>('input[name=import-start-zone]')!, 'Asia/Singapore');
	await settle();
	connect(f.el).click();
	await vi.waitFor(() =>
		expect(f.paired).toEqual([
			{ importStart: { kind: 'since', date: '2026-10-21', zone: 'Asia/Singapore' } }
		])
	);
});

it('shows a legacy All available history boundary on the connected card and applies edits without pairing again', async () => {
	const f = show({
		providers: [{ ...GOOGLE, importStart: { kind: 'timestamp' } }],
		instance: { id: 'mail', status: { state: 'connected' } },
		connection: { state: 'connected', stored: true, importStart: null }
	});
	await f.ready();
	await vi.waitFor(() =>
		expect(f.el.querySelector('[data-import-start-active]')?.textContent).toContain(
			'All available history'
		)
	);
	expect(f.calls).toEqual([]);
	[...f.el.querySelectorAll('button')]
		.find((button) => button.textContent?.trim() === 'Manage')!
		.click();
	await settle();
	await chooseImport(f.el, 'since');
	type(f.el.querySelector<HTMLInputElement>('input[name=import-start-date]')!, '2026-10-21');
	type(f.el.querySelector<HTMLInputElement>('input[name=import-start-zone]')!, 'Asia/Singapore');
	await settle();
	f.el.querySelector<HTMLFormElement>('[data-import-start-form]')!.requestSubmit();
	await vi.waitFor(() => expect(f.calls).toEqual(['import-start mail']));
	expect(f.boundaries).toEqual([{ kind: 'since', date: '2026-10-21', zone: 'Asia/Singapore' }]);
	f.publish({
		importStart: {
			kind: 'since',
			at: '2026-10-20T16:00:00.000Z',
			zone: 'Asia/Singapore',
			origin: 'date'
		}
	});
	await vi.waitFor(() =>
		expect(f.el.querySelector('[data-import-start-active]')?.textContent).toContain(
			'Asia/Singapore'
		)
	);
	expect(f.paired).toEqual([]);
});

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

const dialog = () => document.querySelector<HTMLElement>('[data-confirm-dialog]');

it('Disconnect asks in-app, unpairs on confirm, then removes the instance and shows it not connected', async () => {
	// a WebView answers `window.confirm` with false at once: the card must never depend on it
	const native = vi.fn(() => false);
	vi.stubGlobal('confirm', native);
	const { el, calls } = show({
		providers: [LINKED],
		instance: { id: 'phone', status: { state: 'connected', account: '6591234567' } },
		connection: { state: 'connected', stored: true, account: '6591234567' }
	});
	await settle();
	await vi.waitFor(() => expect(el.textContent).toContain('Connected as 6591234567'));
	expect(el.textContent?.match(/6591234567/g)).toHaveLength(1); // the account once, in the one status line
	expect(el.querySelector('[data-connect]')).toBeNull();
	el.querySelector<HTMLButtonElement>('[data-disconnect]')!.click();
	await vi.waitFor(() => expect(dialog()).not.toBeNull());
	expect(dialog()!.getAttribute('role')).toBe('alertdialog');
	expect(dialog()!.textContent).toContain('Disconnect WhatsApp?');
	expect(calls).toEqual([]);
	dialog()!.querySelector<HTMLButtonElement>('[data-confirm-accept]')!.click();
	await vi.waitFor(() => expect(calls).toEqual(['unpair phone', 'remove phone']));
	await vi.waitFor(() =>
		expect(el.querySelector('[data-connector-state]')?.textContent?.trim()).toBe('Not connected')
	);
	expect(el.querySelector('[data-disconnect]')).toBeNull();
	expect(el.querySelector('[data-connect]')).not.toBeNull();
	expect(native).not.toHaveBeenCalled();
});

it('Disconnect cancelled in-app (or by Escape) leaves the connection alone', async () => {
	const { el, calls } = show({
		providers: [LINKED],
		instance: { id: 'phone', status: { state: 'connected', account: '6591234567' } },
		connection: { state: 'connected', stored: true, account: '6591234567' }
	});
	await vi.waitFor(() => expect(el.querySelector('[data-disconnect]')).not.toBeNull());
	el.querySelector<HTMLButtonElement>('[data-disconnect]')!.click();
	await vi.waitFor(() => expect(dialog()).not.toBeNull());
	dialog()!.querySelector<HTMLButtonElement>('[data-confirm-cancel]')!.click();
	await vi.waitFor(() => expect(dialog()?.dataset['state']).not.toBe('open'));
	el.querySelector<HTMLButtonElement>('[data-disconnect]')!.click();
	await vi.waitFor(() =>
		expect(document.querySelector('[data-confirm-dialog][data-state=open]')).not.toBeNull()
	);
	document
		.querySelector('[data-confirm-dialog][data-state=open]')!
		.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	await vi.waitFor(() =>
		expect(document.querySelector('[data-confirm-dialog][data-state=open]')).toBeNull()
	);
	await settle();
	expect(calls).toEqual([]);
	expect(el.querySelector('[data-connector-state]')?.textContent).toContain(
		'Connected as 6591234567'
	);
});

it('keeps every reported connection state and waits for a fresh status instead of saying not paired', async () => {
	for (const [status, label] of [
		['pairing', 'Pairing'],
		['connecting', 'Connecting'],
		['reconnecting', 'Reconnecting'],
		['error', 'Needs attention'],
		[null, 'Asking the host…']
	] satisfies readonly [InstanceStatus['state'] | null, string][]) {
		const { el } = show({
			providers: [LINKED],
			instance: { id: 'phone', status: { state: 'connected' } },
			connection: status === null ? undefined : { state: status },
			loading: status === null
		});
		await vi.waitFor(() =>
			expect(el.querySelector('[data-connector-state]')?.textContent).toContain(label)
		);
		expect(el.querySelector('[data-disconnect]')).toBeNull();
		if (label === 'Needs attention') expect(connect(el).textContent?.trim()).toBe('Try again');
	}
});

it('offers cancellation before authentication, without a disconnect confirmation', async () => {
	const { el, calls } = show({
		providers: [LINKED],
		instance: { id: 'phone', status: { state: 'pairing' } },
		connection: { state: 'pairing', stored: true }
	});
	await settle();
	expect(el.textContent).not.toContain('Disconnect');
	await vi.waitFor(() =>
		expect(el.querySelector('[data-cancel-setup]')?.textContent?.trim()).toBe('Cancel pairing')
	);
	el.querySelector<HTMLButtonElement>('[data-cancel-setup]')!.click();
	await vi.waitFor(() => expect(calls).toEqual(['unpair phone', 'remove phone']));
	expect(dialog()).toBeNull();
});

it('shows a newly paired success before details, then opens details only through Manage', async () => {
	const f = show({ providers: [LINKED] });
	await settle();
	connect(f.el).click();
	await vi.waitFor(() => expect(f.calls).toEqual(['create', 'pair mine']));
	await f.ready();
	f.state.instance = { id: 'mine', status: { state: 'pairing' } };
	f.publish({ state: 'pairing', pairing: { kind: 'code', value: 'ABCD-1234' } });
	await vi.waitFor(() => expect(f.el.querySelector('[data-pairing=code]')).not.toBeNull());
	expect(f.el.querySelector('[data-connector-state]')?.textContent?.trim()).toBe('Pairing');
	expect(f.el.textContent).not.toContain('Disconnect');
	f.publish({ state: 'connected', stored: true, account: '6591234567' });
	await vi.waitFor(() =>
		expect(f.el.querySelector('[data-connection-success][role=status]')?.textContent?.trim()).toBe(
			'Connected as 6591234567'
		)
	);
	expect(f.el.querySelector('[data-setup-view]')).toBeNull();
	[...f.el.querySelectorAll('button')]
		.find((button) => button.textContent?.trim() === 'Manage')!
		.click();
	await vi.waitFor(() => expect(f.el.querySelector('[data-setup-view=connected]')).not.toBeNull());
	expect(
		[...f.el.querySelectorAll('button')].filter(
			(button) => button.textContent?.trim() === 'Disconnect'
		)
	).toHaveLength(1);
});

it('does not repeat pairing success for an already connected account', async () => {
	const { el } = show({
		providers: [LINKED],
		instance: { id: 'phone', status: { state: 'connected', account: '6591234567' } },
		connection: { state: 'connected', stored: true, account: '6591234567' }
	});
	await settle();
	expect(el.querySelector('[data-connection-success]')).toBeNull();
	expect(el.querySelector('[data-setup-view]')).toBeNull();
});

it('opens the full settings sheet for its existing instance and keeps a paused channel visible', async () => {
	const managed: string[] = [];
	const { el, calls } = show({
		providers: [LINKED],
		instance: { id: 'desk', status: { state: 'connected' }, active: false },
		connection: { state: 'connected', stored: true },
		onManage: (instance) => managed.push(instance)
	});
	await settle();
	expect(el.querySelector('[data-connector-state=paused]')?.textContent?.trim()).toBe('Paused');
	const settings = el.querySelector<HTMLButtonElement>('[data-settings]');
	if (settings === null) throw new Error('Missing instance settings action.');
	expect(settings.getAttribute('aria-label')).toBe('Settings');
	settings.click();
	expect(managed).toEqual(['desk']);
	expect(calls).toEqual([]);
	expect(el.querySelector('[data-setup-view]')).toBeNull();
});

it('keeps following the live lifecycle after success while durable status remains stale', async () => {
	const f = show({
		providers: [LINKED],
		instance: { id: 'phone', status: { state: 'pairing' } },
		connection: { state: 'pairing', stored: true, pairing: { kind: 'code', value: 'old-code' } }
	});
	await f.ready();
	await vi.waitFor(() =>
		expect(f.el.querySelector('[data-connector-state]')?.textContent?.trim()).toBe('Pairing')
	);
	f.publish({ state: 'connected', account: '6591234567' });
	await vi.waitFor(() => expect(f.el.querySelector('[data-connection-success]')).not.toBeNull());
	expect(f.el.querySelector('[data-setup-view]')).toBeNull();
	for (const [state, label] of [
		['reconnecting', 'Reconnecting'],
		['connecting', 'Connecting'],
		['pairing', 'Pairing'],
		['error', 'Needs attention']
	] satisfies readonly [InstanceStatus['state'], string][]) {
		f.publish({ state });
		await vi.waitFor(() =>
			expect(f.el.querySelector('[data-connector-state]')?.textContent?.trim()).toBe(label)
		);
		expect(f.el.querySelector('[data-connection-success]')).toBeNull();
		expect(f.el.querySelector('[data-disconnect]')).toBeNull();
	}
	expect(connect(f.el).textContent?.trim()).toBe('Try again');
	expect(f.el.querySelector('[data-pairing]')).toBeNull();
	connect(f.el).click();
	await vi.waitFor(() => expect(f.calls).toEqual(['pair phone']));
});
