// A channel's connection UI (rule 61). The shell owns the connection — it reads the host, holds the stream, and sends
// the verbs — and draws every provider from the data the host publishes: the provider's `SetupDescription` while it is
// being set up, its `about` facts once it is connected. Bolt names no provider (P18), so there is no provider's
// component here; a `custom` channel is the one exception, drawn by the workspace's own `+<name>.connect.svelte`.
import type { Component } from 'svelte';
import type { Json } from '../../decl/values.ts';
import { localText, type ChannelConnection, type LocalText } from '../../engine/channels/connection.ts';
import { isObj } from '../../engine/channels/store.ts';

/** What a workspace's connect component is given. The host is reached through the two verbs, never through the client. */
export type ConnectProps = {
	/** The declared channel, not the transport. */
	channel: string;
	/** The last state the host published; `null` while the first read is in flight. */
	connection: ChannelConnection | null;
	/** Pairs with whatever the provider's setup collects; the host refuses a malformed body. */
	pair: (input?: Json) => Promise<void>;
	/** Unpairs: the credential is destroyed and the provider forgets this host. */
	unpair: () => Promise<void>;
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
export const sayOf = (t: (key: string) => string, locale: string | undefined) => (x: LocalText): string => typeof x === 'string' ? t(x) : localText(x, locale ?? 'en');

/** A workspace's connect component: one lazy module. */
export type ConnectLoader = () => Promise<{ default: Component<ConnectProps> }>;

/** The host's `about` as an object; anything else publishes no facts. */
export const aboutOf = (c: ChannelConnection | null): { readonly [k: string]: Json } => isObj(c?.about) ? c.about : {};

/** Transports and words a channel name carries, in their brands' own casing. */
const BRANDS: { readonly [word: string]: string } = { whatsapp: 'WhatsApp', wechat: 'WeChat', telegram: 'Telegram', slack: 'Slack',
	discord: 'Discord', email: 'Email', imap: 'IMAP', smtp: 'SMTP', sms: 'SMS' };
const cap = (w: string) => w.replace(/^\w/, (x) => x.toUpperCase());
/** A transport as its brand's name (`whatsapp` → `WhatsApp`). */
export const transportLabel = (transport: string): string => BRANDS[transport] ?? cap(transport);
/** A channel's name: the catalog's `channels.<name>.label`, else humanized with brand casing (`site_whatsapp` → `Site WhatsApp`). */
export const channelLabel = (name: string, t: (key: string) => string): string => {
	const key = `channels.${name}.label`, s = t(key);
	return s !== key ? s : name.split(/[_-]+/).filter((w) => w !== '').map((w, i) => BRANDS[w] ?? (i === 0 ? cap(w) : w)).join(' ');
};

/** The state line every channel shows, so two providers never word the same state differently. */
export const connectionLabel = (c: ChannelConnection | null, t: (key: string) => string): string => {
	if (c === null) return t('Asking the host…');
	switch (c.state) {
		case 'connected':
			return c.pairedAs === undefined || c.pairedAs === null || c.pairedAs === '' ? t('Connected') : t('Connected as {as}').replace('{as}', c.pairedAs);
		case 'pairing': return t('Pairing');
		// a retry is progress. Reading one as a failure is what sends an operator hunting a fault that is not there.
		case 'reconnecting': return t('Reconnecting');
		case 'connecting': return t('Connecting');
		case 'error': return t('Needs attention');
		default: return c.stored ? t('Paired, not connected') : t('Not paired');
	}
};
