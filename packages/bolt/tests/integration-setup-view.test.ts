// @vitest-environment happy-dom
// An integration instance's setup renderer (§4.5, P18): every provider drawn from the setup description its host
// publishes — the provider choice, a form whose refusal is shown verbatim, a QR and a code — the switch to the connected
// summary, the disconnect verb, and a definition drawn by the workspace's own `+integration.svelte` when it has one.
import './setup-happy-dom.js';
import { Deferred, Effect, Layer, ManagedRuntime } from 'effect';
import { mountEdge, run } from '@norbital-ai/ui/effect';
import { flushSync, mount, tick, unmount } from 'svelte';
import { beforeEach, afterEach, expect, it, vi } from '@effect/vitest';
import type { Json } from '../src/decl/values.ts';
import type {
	ImportStartInput,
	InstanceStatus,
	ProviderChoice
} from '../src/protocol/instance-status.ts';
import Setup from '../src/shell/integration/Setup.svelte';
import type { IntegrationSetupEntry, IntegrationSetupLoader } from '../src/page/integration.ts';
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
});
const settle = async () => {
	await tick();
	flushSync();
};

const OFFICIAL: ProviderChoice = {
	id: 'official',
	label: 'Official',
	setup: {
		kind: 'form',
		webhook: true,
		steps: [
			{ text: 'Create an account', href: 'https://provider.example/console' },
			{ text: 'Paste this webhook URL', copy: 'webhookUrl' }
		],
		fields: [
			{ name: 'accountSid', label: 'Account' },
			{ name: 'authToken', label: 'Token', secret: true },
			{ name: 'from', label: 'Sender', hint: 'In E.164' }
		]
	}
};
const LINKED: ProviderChoice = {
	id: 'linked',
	label: 'Linked device',
	setup: {
		kind: 'qr',
		steps: [{ text: 'Open the app' }],
		fields: [{ name: 'phone', label: 'Phone', optional: true }]
	}
};
const HOOK = 'https://host.example/acme/hooks/integration/support';
const base = (more: Partial<InstanceStatus> = {}): InstanceStatus => ({
	instance: 'support',
	integration: 'whatsapp',
	driver: 'whatsapp',
	state: 'unpaired',
	stored: false,
	providers: [OFFICIAL, LINKED],
	about: { webhookUrl: HOOK },
	...more
});

function show(props: {
	connection: InstanceStatus | null;
	error?: string | null;
	setup?: IntegrationSetupEntry;
}) {
	const paired: Json[] = [];
	const boundaries: ImportStartInput[] = [];
	const pairedReady = Deferred.makeUnsafe<void>(),
		unpairedReady = Deferred.makeUnsafe<void>();
	let unpaired = 0;
	const state = reactive<{ connection: InstanceStatus | null; error: string | null }>({
		connection: props.connection,
		error: props.error ?? null
	});
	const target = document.body.appendChild(document.createElement('div'));
	const v = mount(Setup, {
		target,
		props: {
			instance: 'support',
			busy: false,
			t: (k: string) => k,
			setup: props.setup,
			get status() {
				return state.connection;
			},
			get error() {
				return state.error;
			},
			pair: (input?: Json) =>
				Effect.sync(() => {
					paired.push(input ?? {});
					Deferred.doneUnsafe(pairedReady, Effect.void);
				}),
			unpair: () =>
				Effect.sync(() => {
					unpaired++;
					Deferred.doneUnsafe(unpairedReady, Effect.void);
				}),
			test: () => Effect.void,
			importStart: (input: ImportStartInput) =>
				Effect.sync(() => {
					boundaries.push(input);
					return true;
				})
		}
	});
	views.push(async () => {
		await unmount(v);
		target.remove();
	});
	return {
		el: target,
		paired,
		boundaries,
		waitPair: () => run(Deferred.await(pairedReady)),
		waitUnpair: () => run(Deferred.await(unpairedReady)),
		unpaired: () => unpaired,
		state
	};
}
const button = (el: HTMLElement, label: string) =>
	[...el.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button, a')].find(
		(b) => b.textContent?.trim() === label
	);
const type = (input: HTMLInputElement, value: string) => {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
};

it('keeps a saved From now instant when pairing is retried without editing the import start', async () => {
	vi.spyOn(window, 'open').mockReturnValue(null);
	const { el, paired, waitPair } = show({
		connection: base({
			providers: [
				{
					id: 'google',
					label: 'Gmail',
					importStart: { kind: 'timestamp' },
					setup: { kind: 'oauth', steps: [] }
				}
			],
			importStart: {
				kind: 'since',
				at: '2026-10-20T16:00:00.000Z',
				zone: 'Asia/Singapore',
				origin: 'now'
			}
		})
	});
	await settle();
	expect(el.querySelector('[data-import-start]')?.textContent).toContain('From now');
	expect(el.querySelector<HTMLInputElement>('input[name=import-start-zone]')?.value).toBe(
		'Asia/Singapore'
	);
	button(el, 'Gmail')!.click();
	await waitPair();
	expect(paired).toEqual([{}]);
});

it('collects an import date on the standalone pairing view only when explicitly selected', async () => {
	vi.spyOn(window, 'open').mockReturnValue(null);
	const { el, paired, waitPair } = show({
		connection: base({
			providers: [
				{
					id: 'google',
					label: 'Gmail',
					importStart: { kind: 'timestamp' },
					setup: { kind: 'oauth', steps: [] }
				}
			],
			importStart: null
		})
	});
	await settle();
	expect(el.querySelector('[data-import-start]')?.textContent).toContain('All available history');
	expect(paired).toEqual([]);
	el.querySelector<HTMLButtonElement>('[role=combobox][aria-label="Import start"]')!.click();
	await settle();
	document.querySelector<HTMLButtonElement>('[role=option][data-value=since] button')!.click();
	await settle();
	type(el.querySelector<HTMLInputElement>('input[name=import-start-date]')!, '2026-10-21');
	type(el.querySelector<HTMLInputElement>('input[name=import-start-zone]')!, 'Asia/Singapore');
	await settle();
	button(el, 'Gmail')!.click();
	await waitPair();
	expect(paired).toEqual([
		{ importStart: { kind: 'since', date: '2026-10-21', zone: 'Asia/Singapore' } }
	]);
});

it('does not move an edited From now boundary again after the host saves it and pairing fails', async () => {
	vi.spyOn(window, 'open').mockReturnValue(null);
	const google: ProviderChoice = {
		id: 'google',
		label: 'Gmail',
		importStart: { kind: 'timestamp' },
		setup: { kind: 'oauth', steps: [] }
	};
	const { el, paired, state, waitPair } = show({
		connection: base({ providers: [google], importStart: null })
	});
	await settle();
	el.querySelector<HTMLButtonElement>('[role=combobox][aria-label="Import start"]')!.click();
	await settle();
	document.querySelector<HTMLButtonElement>('[role=option][data-value=now] button')!.click();
	await settle();
	button(el, 'Gmail')!.click();
	await waitPair();
	expect(paired[0]).toMatchObject({ importStart: { kind: 'now' } });
	state.connection = base({
		providers: [google],
		state: 'error',
		importStart: {
			kind: 'since',
			at: '2026-10-20T16:00:00.000Z',
			zone: 'Asia/Singapore',
			origin: 'now'
		}
	});
	await settle();
	button(el, 'Try again')!.click();
	await vi.waitFor(() => expect(paired).toHaveLength(2));
	expect(paired[1]).toEqual({});
});

it('asks which provider first when the driver has several, then draws that provider’s steps and form', async () => {
	const { el } = show({ connection: base() });
	await settle();
	expect(el.querySelector('[data-setup-view=pair]')).not.toBeNull();
	expect([...el.querySelectorAll('[data-provider]')].map((b) => b.textContent?.trim())).toEqual([
		'Official',
		'Linked device'
	]);
	expect(el.querySelector('[data-setup-form]')).toBeNull();
	button(el, 'Official')!.click();
	await settle();
	expect(el.querySelector('[data-provider-choice]')).toBeNull();
	expect(
		[...el.querySelectorAll('[data-setup-steps] li > span:first-child')].map((x) => x.textContent)
	).toEqual(['Create an account', 'Paste this webhook URL']);
	expect(el.querySelector<HTMLAnchorElement>('[data-setup-steps] a')!.href).toBe(
		'https://provider.example/console'
	);
	expect(el.querySelector('[data-setup-steps]')!.textContent).toContain(HOOK); // the URL to paste, with its copy button
	await vi.waitFor(() =>
		expect(el.querySelector('[data-setup-steps] button[aria-label=Copy]')).not.toBeNull()
	);
	// choosing again returns to the choice
	button(el, 'Choose another provider')!.click();
	await settle();
	expect(el.querySelector('[data-provider-choice]')).not.toBeNull();
});

it('sends the form’s fields with the chosen provider, and shows the host’s refusal verbatim', async () => {
	const { el, paired, state, waitPair } = show({ connection: base() });
	await settle();
	button(el, 'Official')!.click();
	await settle();
	const inputs = [...el.querySelectorAll<HTMLInputElement>('[data-setup-form] input')];
	expect(inputs.map((i) => [i.name, i.type, i.required])).toEqual([
		['accountSid', 'text', true],
		['authToken', 'password', true],
		['from', 'text', true]
	]);
	expect(el.querySelector('[data-setup-form]')!.textContent).toContain('In E.164');
	type(inputs[0]!, ' AC1 ');
	type(inputs[1]!, 'secret');
	type(inputs[2]!, '+6500000000');
	el.querySelector<HTMLFormElement>('[data-setup-form]')!.requestSubmit();
	await waitPair();
	await settle();
	expect(paired).toEqual([
		{ provider: 'official', accountSid: 'AC1', authToken: 'secret', from: '+6500000000' }
	]);
	expect(inputs[1]!.value).toBe(''); // a secret is not left in the page
	state.error = 'The auth token does not match the account (20003).';
	await settle();
	expect(el.querySelector('[data-connection-error]')!.textContent).toBe(
		'The auth token does not match the account (20003).'
	);
});

it('sends a single provider’s fields alone, with no provider key', async () => {
	const bot: ProviderChoice = {
		id: 'bot',
		label: 'Bot',
		setup: {
			kind: 'form',
			steps: [],
			fields: [{ name: 'token', label: 'Bot token', secret: true }]
		}
	};
	const { el, paired, waitPair } = show({ connection: base({ providers: [bot] }) });
	await settle();
	expect(el.querySelector('[data-provider-choice]')).toBeNull();
	type(el.querySelector<HTMLInputElement>('[data-setup-form] input')!, '123:AA');
	el.querySelector<HTMLFormElement>('[data-setup-form]')!.requestSubmit();
	await waitPair();
	await settle();
	expect(paired).toEqual([{ token: '123:AA' }]);
});

it('draws the QR, then the code, the provider publishes while pairing; an optional field left empty is not sent', async () => {
	const { el, paired, state, waitPair } = show({ connection: base({ provider: 'linked' }) });
	await settle();
	expect(el.querySelector<HTMLInputElement>('[data-setup-form] input[name=phone]')!.required).toBe(
		false
	);
	el.querySelector<HTMLFormElement>('[data-setup-form]')!.requestSubmit();
	await waitPair();
	await settle();
	expect(paired).toEqual([{ provider: 'linked' }]);
	state.connection = base({
		provider: 'linked',
		state: 'pairing',
		pairing: { kind: 'qr', value: '2@abc' }
	});
	await settle();
	expect(el.querySelector('[data-pairing=qr]')).not.toBeNull();
	// the QR is the way in; the phone number for a code instead stays one click away
	expect(el.querySelector('[data-setup-view=pair] > [data-setup-form]')).toBeNull();
	expect(el.querySelector('[data-pairing-alternative] input[name=phone]')).not.toBeNull();
	state.connection = base({
		provider: 'linked',
		state: 'pairing',
		pairing: { kind: 'code', value: 'ABCD-1234' }
	});
	await settle();
	expect(el.querySelector('[data-pairing=code] code')!.textContent).toBe('ABCD-1234');
});

it('switches from Setup to the Connected summary when the host says connected, and disconnects from there', async () => {
	const { el, state, unpaired, waitUnpair } = show({
		connection: base({ provider: 'official', state: 'connecting', stored: true })
	});
	await settle();
	expect(el.querySelector('[data-setup-view=pair]')).not.toBeNull();
	state.connection = base({
		provider: 'official',
		state: 'connected',
		stored: true,
		account: '+6500000000',
		about: { webhookUrl: HOOK, from: '+6500000000' }
	});
	await settle();
	expect(el.querySelector('[data-setup-view=pair]')).toBeNull();
	const card = el.querySelector('[data-setup-view=connected]')!;
	expect(card).not.toBeNull();
	expect(el.querySelector('[data-connection-state]')!.textContent).toBe(
		'Connected as {as}'.replace('{as}', '+6500000000')
	);
	expect([...card.querySelectorAll('dt')].map((x) => x.textContent)).toEqual([
		'Connected as',
		'Provider',
		'Webhook URL',
		'Sender'
	]);
	expect(card.querySelector('[data-fact=Provider]')!.textContent).toContain('Official'); // the label, not the id
	expect(card.querySelector('[data-fact=webhookUrl]')!.textContent).toContain(HOOK);
	button(el, 'Disconnect')!.click();
	await waitUnpair();
	expect(unpaired()).toBe(1);
});

it('shows connection progress after pairing, keeps disconnect, and restores setup if pairing is needed again', async () => {
	const { el, state, unpaired, waitUnpair } = show({
		connection: base({
			provider: 'linked',
			state: 'connecting',
			stored: true,
			detail: 'Catching up on missed messages'
		})
	});
	await settle();
	const progress = el.querySelector('[data-connection-progress]');
	expect(progress?.querySelector('[data-accretion-disc]')).not.toBeNull();
	expect(progress?.querySelector('[role=status]')?.textContent).toContain(
		'Catching up on missed messages'
	);
	expect(el.querySelector('[data-setup-steps]')).toBeNull();
	expect(el.querySelector('[data-setup-form]')).toBeNull();
	expect(el.textContent).not.toContain('The code appears when the provider publishes it.');
	expect(el.textContent?.match(/Linked device/g)).toHaveLength(1);
	button(el, 'Disconnect')!.click();
	await waitUnpair();
	expect(unpaired()).toBe(1);
	state.connection = base({
		provider: 'linked',
		state: 'pairing',
		pairing: { kind: 'qr', value: '2@abc' }
	});
	await settle();
	expect(el.querySelector('[data-connection-progress]')).toBeNull();
	expect(el.querySelector('[data-setup-steps]')).not.toBeNull();
	expect(el.querySelector('[data-pairing=qr]')).not.toBeNull();
});

it('an OAuth mailbox: the redirect URI to register, a choice field, then a sign-in button that opens a popup', async () => {
	const ms: ProviderChoice = {
		id: 'microsoft',
		label: 'Microsoft 365',
		setup: {
			kind: 'form',
			steps: [{ text: 'Register this redirect URI', copy: 'redirectUrl' }],
			fields: [
				{ name: 'clientId', label: 'Client ID' },
				{
					name: 'tracking',
					label: 'Open tracking',
					optional: true,
					options: [
						{ value: 'off', label: 'Off' },
						{ value: 'on', label: 'On' }
					]
				}
			]
		}
	};
	const REDIRECT = 'https://host.example/acme/hooks/oauth/callback';
	const { el, state, paired, waitPair } = show({
		connection: base({
			integration: 'email',
			driver: 'email',
			providers: [ms],
			about: { redirectUrl: REDIRECT }
		})
	});
	await settle();
	expect(el.querySelector('[data-setup-steps]')!.textContent).toContain(REDIRECT);
	type(el.querySelector<HTMLInputElement>('input[name=clientId]')!, 'app-1');
	el.querySelector<HTMLButtonElement>('[role=combobox][aria-label="Open tracking"]')!.click();
	await settle();
	expect(
		[...document.querySelectorAll('[role=listbox] [role=option]')].map((o) =>
			o.getAttribute('data-value')
		)
	).toEqual(['off', 'on']);
	document.querySelector<HTMLButtonElement>('[role=listbox] [data-value=on] button')!.click();
	await settle();
	el.querySelector<HTMLFormElement>('[data-setup-form]')!.requestSubmit();
	await waitPair();
	await settle();
	expect(paired).toEqual([{ clientId: 'app-1', tracking: 'on' }]);
	const opened: string[] = [];
	vi.spyOn(window, 'open').mockImplementation((url) => {
		opened.push(String(url));
		return window;
	});
	state.connection = base({
		integration: 'email',
		driver: 'email',
		state: 'pairing',
		providers: [ms],
		about: { redirectUrl: REDIRECT },
		pairing: {
			kind: 'oauth',
			value: 'https://login.example/authorize?state=s',
			label: 'Sign in with Microsoft'
		}
	});
	await settle();
	expect(el.querySelector('[data-setup-form]')).toBeNull();
	button(el, 'Sign in with Microsoft')!.click();
	expect(opened).toEqual(['https://login.example/authorize?state=s']);
	expect(el.querySelector<HTMLAnchorElement>('[data-pairing=oauth] a')?.href).toBe(
		'https://login.example/authorize?state=s'
	);
});

it('distinguishes an unread status and a failed read from a loaded host with no provider', async () => {
	const { el, state } = show({ connection: null });
	await settle();
	expect(el.textContent).toContain('Asking the host…');
	expect(el.textContent).not.toContain('This host offers no provider');
	state.error = 'The connection could not be loaded.';
	await settle();
	expect(el.querySelector('[role=alert]')?.textContent).toContain('could not be loaded');
	expect(el.textContent).not.toContain('This host offers no provider');
	state.connection = base({ providers: [] });
	state.error = null;
	await settle();
	expect(el.textContent).toContain('This host offers no provider');
});

it('draws a definition with the workspace’s own file in place of the generic views, loading it once', async () => {
	const Own = (await import('./support/own-setup.svelte')).default;
	const load = vi.fn<IntegrationSetupLoader>(async () => ({ default: Own }));
	const withFile = show({ connection: base(), setup: { load } });
	await vi.waitFor(() =>
		expect(withFile.el.querySelector('[data-own-connect]')?.textContent).toBe('support')
	);
	expect(withFile.el.querySelector('[data-setup-view]')).toBeNull();
	withFile.state.connection = base({ state: 'connected', stored: true });
	await settle();
	expect(load).toHaveBeenCalledTimes(1);
	const generic = show({ connection: base() });
	await settle();
	expect(generic.el.querySelector('[data-setup-view=pair]')).not.toBeNull();
});
