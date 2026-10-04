// @vitest-environment happy-dom
// The channel setup renderer (rule 61, P18): every provider drawn from the setup description its host publishes — the
// provider choice, a form whose refusal is shown verbatim, a QR and a code — the switch to the connected summary, the
// disconnect verb, and a custom channel drawn by the workspace's own file (or said to be missing).
import './setup-happy-dom.js';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { ChannelConnection, ProviderChoice } from '../src/engine/channels/connection.ts';
import Connection from '../src/shell/channels/Connection.svelte';
import type { ConnectLoader } from '../src/shell/channels/connect.ts';
import { reactive } from './support/reactive.svelte.ts';

const views: (() => void)[] = [];
afterEach(() => { for (const v of views.splice(0)) v(); });
const settle = async () => { for (let i = 0; i < 5; i++) { await tick(); await new Promise((r) => setTimeout(r, 0)); } flushSync(); };

const OFFICIAL: ProviderChoice = { id: 'official', label: 'Official', setup: { kind: 'form', webhook: true,
	steps: [{ text: 'Create an account', href: 'https://provider.example/console' }, { text: 'Paste this webhook URL', copy: 'webhookUrl' }],
	fields: [{ name: 'accountSid', label: 'Account' }, { name: 'authToken', label: 'Token', secret: true }, { name: 'from', label: 'Sender', hint: 'In E.164' }] } };
const LINKED: ProviderChoice = { id: 'linked', label: 'Linked device', setup: { kind: 'qr', steps: [{ text: 'Open the app' }],
	fields: [{ name: 'phone', label: 'Phone', optional: true }] } };
const HOOK = 'https://host.example/hooks/bolt.chat/support';
const base = (more: Partial<ChannelConnection> = {}): ChannelConnection =>
	({ channel: 'support', transport: 'chat', state: 'unpaired', stored: false, providers: [OFFICIAL, LINKED], about: { webhookUrl: HOOK }, ...more });

function show(props: { connection: ChannelConnection | null; error?: string | null; transport?: string; workspace?: Record<string, ConnectLoader> }) {
	const paired: Json[] = [];
	let unpaired = 0;
	const state = reactive<{ connection: ChannelConnection | null; error: string | null }>({ connection: props.connection, error: props.error ?? null });
	const target = document.body.appendChild(document.createElement('div'));
	const v = mount(Connection, { target, props: {
		channel: 'support', transport: props.transport ?? 'chat', busy: false, t: (k: string) => k, workspace: props.workspace,
		get connection() { return state.connection; }, get error() { return state.error; },
		pair: async (input?: Json) => void paired.push(input ?? {}), unpair: async () => void unpaired++ } });
	views.push(() => { void unmount(v); target.remove(); });
	return { el: target, paired, unpaired: () => unpaired, state };
}
const button = (el: HTMLElement, label: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const type = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };

it('asks which provider first when the transport has several, then draws that provider’s steps and form', async () => {
	const { el } = show({ connection: base() });
	await settle();
	expect(el.querySelector('[data-channel-view=setup]')).not.toBeNull();
	expect([...el.querySelectorAll('[data-provider]')].map((b) => b.textContent?.trim())).toEqual(['Official', 'Linked device']);
	expect(el.querySelector('[data-setup-form]')).toBeNull();
	button(el, 'Official')!.click();
	await settle();
	expect(el.querySelector('[data-provider-choice]')).toBeNull();
	expect([...el.querySelectorAll('[data-setup-steps] li > span:first-child')].map((x) => x.textContent)).toEqual(['Create an account', 'Paste this webhook URL']);
	expect(el.querySelector<HTMLAnchorElement>('[data-setup-steps] a')!.href).toBe('https://provider.example/console');
	expect(el.querySelector('[data-setup-steps]')!.textContent).toContain(HOOK); // the URL to paste, with its copy button
	expect(el.querySelector('[data-setup-steps] button[aria-label=Copy]')).not.toBeNull();
	// choosing again returns to the choice
	button(el, 'Choose another provider')!.click();
	await settle();
	expect(el.querySelector('[data-provider-choice]')).not.toBeNull();
});

it('sends the form’s fields with the chosen provider, and shows the host’s refusal verbatim', async () => {
	const { el, paired, state } = show({ connection: base() });
	await settle();
	button(el, 'Official')!.click();
	await settle();
	const inputs = [...el.querySelectorAll<HTMLInputElement>('[data-setup-form] input')];
	expect(inputs.map((i) => [i.name, i.type, i.required])).toEqual([['accountSid', 'text', true], ['authToken', 'password', true], ['from', 'text', true]]);
	expect(el.querySelector('[data-setup-form]')!.textContent).toContain('In E.164');
	type(inputs[0]!, ' AC1 '); type(inputs[1]!, 'secret'); type(inputs[2]!, '+6500000000');
	el.querySelector<HTMLFormElement>('[data-setup-form]')!.requestSubmit();
	await settle();
	expect(paired).toEqual([{ provider: 'official', accountSid: 'AC1', authToken: 'secret', from: '+6500000000' }]);
	expect(inputs[1]!.value).toBe(''); // a secret is not left in the page
	state.error = 'The auth token does not match the account (20003).';
	await settle();
	expect(el.querySelector('[data-connection-error]')!.textContent).toBe('The auth token does not match the account (20003).');
});

it('sends a single provider’s fields alone, with no provider key', async () => {
	const bot: ProviderChoice = { id: 'bot', label: 'Bot', setup: { kind: 'form', steps: [], fields: [{ name: 'token', label: 'Bot token', secret: true }] } };
	const { el, paired } = show({ connection: base({ providers: [bot] }) });
	await settle();
	expect(el.querySelector('[data-provider-choice]')).toBeNull();
	type(el.querySelector<HTMLInputElement>('[data-setup-form] input')!, '123:AA');
	el.querySelector<HTMLFormElement>('[data-setup-form]')!.requestSubmit();
	await settle();
	expect(paired).toEqual([{ token: '123:AA' }]);
});

it('draws the QR, then the code, the provider publishes while pairing; an optional field left empty is not sent', async () => {
	const { el, paired, state } = show({ connection: base({ provider: 'linked' }) });
	await settle();
	expect(el.querySelector<HTMLInputElement>('[data-setup-form] input[name=phone]')!.required).toBe(false);
	el.querySelector<HTMLFormElement>('[data-setup-form]')!.requestSubmit();
	await settle();
	expect(paired).toEqual([{ provider: 'linked' }]);
	state.connection = base({ provider: 'linked', state: 'pairing', pairing: { kind: 'qr', value: '2@abc' } });
	await settle();
	expect(el.querySelector('[data-pairing=qr]')).not.toBeNull();
	expect(el.querySelector('[data-setup-form]')).toBeNull();
	state.connection = base({ provider: 'linked', state: 'pairing', pairing: { kind: 'code', value: 'ABCD-1234' } });
	await settle();
	expect(el.querySelector('[data-pairing=code] code')!.textContent).toBe('ABCD-1234');
});

it('switches from Setup to the Connected summary when the host says connected, and disconnects from there', async () => {
	const { el, state, unpaired } = show({ connection: base({ provider: 'official', state: 'connecting', stored: true }) });
	await settle();
	expect(el.querySelector('[data-channel-view=setup]')).not.toBeNull();
	state.connection = base({ provider: 'official', state: 'connected', stored: true, pairedAs: '+6500000000', about: { webhookUrl: HOOK, from: '+6500000000' } });
	await settle();
	expect(el.querySelector('[data-channel-view=setup]')).toBeNull();
	const card = el.querySelector('[data-channel-view=connected]')!;
	expect(card).not.toBeNull();
	expect(el.querySelector('[data-connection-state]')!.textContent).toBe('Connected as {as}'.replace('{as}', '+6500000000'));
	expect([...card.querySelectorAll('dt')].map((x) => x.textContent)).toEqual(['Connected as', 'Provider', 'Webhook URL', 'Sender']);
	expect(card.querySelector('[data-fact=Provider]')!.textContent).toContain('Official'); // the label, not the id
	expect(card.querySelector('[data-fact=webhookUrl]')!.textContent).toContain(HOOK);
	button(el, 'Disconnect')!.click();
	await settle();
	expect(unpaired()).toBe(1);
});

it('an OAuth mailbox: the redirect URI to register, a choice field, then a sign-in button that opens a popup', async () => {
	const ms: ProviderChoice = { id: 'microsoft', label: 'Microsoft 365', setup: { kind: 'form', steps: [{ text: 'Register this redirect URI', copy: 'redirectUrl' }],
		fields: [{ name: 'clientId', label: 'Client ID' }, { name: 'tracking', label: 'Open tracking', optional: true, options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] }] } };
	const REDIRECT = 'https://host.example/hooks/bolt.email/support/oauth/callback';
	const { el, state, paired } = show({ connection: base({ transport: 'email', providers: [ms], about: { redirectUrl: REDIRECT } }), transport: 'email' });
	await settle();
	expect(el.querySelector('[data-setup-steps]')!.textContent).toContain(REDIRECT);
	const select = el.querySelector<HTMLSelectElement>('select[name=tracking]')!;
	expect([...select.options].map((o) => o.value)).toEqual(['off', 'on']);
	type(el.querySelector<HTMLInputElement>('input[name=clientId]')!, 'app-1');
	select.value = 'on';
	select.dispatchEvent(new Event('change', { bubbles: true }));
	el.querySelector<HTMLFormElement>('[data-setup-form]')!.requestSubmit();
	await settle();
	expect(paired).toEqual([{ clientId: 'app-1', tracking: 'on' }]);
	const opened: string[] = [];
	window.open = ((url: string) => { opened.push(url); return {} as Window; }) as typeof window.open;
	state.connection = base({ transport: 'email', state: 'pairing', providers: [ms], about: { redirectUrl: REDIRECT },
		pairing: { kind: 'oauth', value: 'https://login.example/authorize?state=s', label: 'Sign in with Microsoft' } });
	await settle();
	expect(el.querySelector('[data-setup-form]')).toBeNull();
	button(el, 'Sign in with Microsoft')!.click();
	expect(opened).toEqual(['https://login.example/authorize?state=s']);
});

it('draws a custom channel with the workspace’s own file, and says so when the file is missing', async () => {
	const Own = (await import('./support/channel-connect.svelte')).default;
	const own: ConnectLoader = async () => ({ default: Own });
	const withFile = show({ connection: base({ transport: 'custom' }), transport: 'custom', workspace: { support: own } });
	await settle();
	expect(withFile.el.querySelector('[data-own-connect]')!.textContent).toBe('support');
	expect(withFile.el.querySelector('[data-channel-view]')).toBeNull();
	const missing = show({ connection: base({ transport: 'custom' }), transport: 'custom', workspace: {} });
	await settle();
	expect(missing.el.querySelector('[data-custom-missing]')!.textContent).toContain('src/custom_channels/support/+channel.configuration.svelte');
});
