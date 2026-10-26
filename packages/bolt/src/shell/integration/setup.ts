// An integration instance's setup UI (§4.5). Its holder reads the host, holds the stream and sends the verbs; every
// provider is drawn from the data the host publishes: the provider's `SetupDescription` while it is being set up, its
// `about` facts once it is connected. Bolt names no provider (P18), so there is no provider's component here; a
// definition's own `integration/<name>/+integration.svelte` draws in its place when the workspace has one.
import { Effect, Schema } from 'effect';
import { ActRefused } from '../../decl/errors.ts';
import type { ActOutcome } from '../../engine/contracts.ts';
import type { Component } from 'svelte';
import type { Json } from '../../decl/values.ts';
import {
	localText,
	type ImportStartInput,
	type InstanceStatus,
	type LocalText,
	type ProviderChoice
} from '../../protocol/instance-status.ts';

/** What an instance's setup view is given (a definition's `+integration.svelte` too): the host is reached through the verbs. */
export type IntegrationSetupProps = {
	instance: string;
	/** The last status the host published; `null` while the first read is in flight. */
	status: InstanceStatus | null;
	/** Pairs with whatever the provider's setup collects; the host refuses a malformed body. */
	pair: (input?: Json) => Effect.Effect<void>;
	/** Changes the import boundary without replacing the account's credentials. */
	importStart: (input: ImportStartInput) => Effect.Effect<boolean>;
	/** Unpairs: the credentials are destroyed and the provider forgets this host. */
	unpair: () => Effect.Effect<void>;
	/** Tests the connected instance (`status.test` says whether a message goes out, and where to). */
	test: (to?: string) => Effect.Effect<void>;
	/** A pairing this page is waiting on: the provider may not take two, so its own button disables on this. */
	busy: boolean;
	/** The host's refusal, verbatim — a provider names what is wrong, and replacing that throws it away. */
	error: string | null;
	/** The page's translator. */
	t: (key: string) => string;
	/** The viewer's locale: a provider's own text (`LocalText`) is picked by it. */
	locale?: string | undefined;
};

/** A provider's text in the viewer's locale; a plain string goes through the page's translator like any shell key. */
export const sayOf =
	(t: (key: string) => string, locale: string | undefined) =>
	(x: LocalText): string =>
		typeof x === 'string' ? t(x) : localText(x, locale ?? 'en');

/** A definition's setup component: one lazy module. */
export type IntegrationSetupLoader = () => Promise<{ default: Component<IntegrationSetupProps> }>;
/** The compiled registry's entry for a definition's `+integration.svelte`. */
export type IntegrationSetupEntry = { load: IntegrationSetupLoader };

/**
 * The OAuth sign-in window, opened by the click that starts a pairing (a popup opened later, once the provider has
 * published its URL, is blocked) and sent to the provider's sign-in when it arrives.
 */
let signInWindow: Window | null = null;
export const reserveSignIn = (): void => {
	signInWindow = window.open('', 'bolt-oauth', 'popup,width=520,height=720');
};
/** Sends the reserved window to `url`; `false` when none is open (the page offers its own sign-in button). */
export const signInTo = (url: string): boolean => {
	const w = signInWindow;
	signInWindow = null;
	if (w === null || w.closed) return false;
	w.location.href = url;
	return true;
};
/** A pairing that failed before its sign-in: the reserved window closes. */
export const releaseSignIn = (): void => {
	signInWindow?.close();
	signInWindow = null;
};
/** Whether a provider's setup pairs on Connect alone (a QR, a code, a sign-in), with nothing to fill in first. */
export const pairsAtOnce = (p: ProviderChoice | undefined): boolean =>
	p !== undefined && (p.setup.kind === 'qr' || p.setup.kind === 'code' || p.setup.kind === 'oauth');

/** The instance a `sys_integration.create` made, or its refusal (`otherwise` when it did not commit for another reason). */
export const instanceMade = (
	outcome: ActOutcome,
	otherwise: string
): Effect.Effect<string, ActRefused> => {
	const row =
		outcome.kind === 'committed'
			? outcome.records.find((r) => r.collection === 'sys_integration')
			: undefined;
	return row === undefined
		? Effect.fail(
				new ActRefused({
					code: 'refused',
					message: outcome.kind === 'refused' ? outcome.message : otherwise
				})
			)
		: Effect.succeed(row.id);
};

/** The host's `about` as an object; anything else publishes no facts. */
export const aboutOf = (c: InstanceStatus | null): { readonly [k: string]: Json } => {
	const about = c?.about;
	return Schema.is(Schema.Record(Schema.String, Schema.Json))(about) ? about : {};
};
/** The provider the instance runs on: the host's active one, else the only one it offers. */
export const providerOf = (c: InstanceStatus | null): ProviderChoice | undefined =>
	c?.providers?.find((p) => p.id === c.provider) ??
	(c?.providers?.length === 1 ? c.providers[0] : undefined);

/** Drivers in their brands' own casing. */
const BRANDS: { readonly [driver: string]: string } = {
	whatsapp: 'WhatsApp',
	wechat: 'WeChat',
	telegram: 'Telegram',
	slack: 'Slack',
	discord: 'Discord',
	email: 'Email',
	http: 'HTTP',
	sqlserver: 'SQL Server',
	calendar: 'Calendar'
};
/** A driver as its brand's name (`whatsapp` → `WhatsApp`). */
export const driverLabel = (driver: string): string =>
	BRANDS[driver] ?? driver.replace(/^\w/, (x) => x.toUpperCase());

/** The state line every instance shows, so two providers never word the same state differently. */
export const statusLabel = (
	c: Pick<InstanceStatus, 'state' | 'account' | 'stored'> | null,
	t: (key: string) => string
): string => {
	if (c === null) return t('Asking the host…');
	switch (c.state) {
		case 'connected':
			return c.account === undefined || c.account === null || c.account === ''
				? t('Connected')
				: t('Connected as {as}').replace('{as}', c.account);
		case 'pairing':
			return t('Pairing');
		// a retry is progress. Reading one as a failure is what sends an operator hunting a fault that is not there.
		case 'reconnecting':
			return t('Reconnecting');
		case 'connecting':
			return t('Connecting');
		case 'error':
			return t('Needs attention');
		default:
			return c.stored ? t('Paired, not connected') : t('Not paired');
	}
};
