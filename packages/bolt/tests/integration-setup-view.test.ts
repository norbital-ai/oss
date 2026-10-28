// @vitest-environment happy-dom
// An integration instance's setup renderer (§4.5, P18): every provider drawn from the setup description its host
// publishes — the provider choice, a form whose refusal is shown verbatim, a QR and a code — and a definition drawn by
// the workspace's own `+integration.svelte` when it has one. Connect and disconnect in a real browser:
// integration-setup.browser.test.ts.
import '../src/test/dom.ts';
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
	const pairedReady = Deferred.makeUnsafe<void>();
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
			unpair: () => Effect.void,
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
