// A channel's connection UI (rule 61). One resolution seam, one component contract, two sources.
//
// The shell owns the connection — it reads the host, holds the stream, and sends the verbs — and a connect component
// owns one thing: what pairing looks like. A provider bolt ships (WhatsApp, Telegram, email) and one a workspace writes
// as `+*.connect.svelte` are the same component behind `connectOf`, so nothing downstream can tell which it is holding,
// and adding a provider is a new entry in `BUILTIN` rather than a new branch anywhere.
//
// Nothing here branches on a transport to decide behaviour: `pairing.kind` says what the provider published and the
// component draws it. A provider nobody has written a component for is `null`, which the page says out loud.
import type { Component } from 'svelte';
import type { Json } from '../../decl/values.ts';
import type { ChannelConnection } from '../../engine/channels/connection.ts';
import WhatsApp from './WhatsApp.svelte';
import Telegram from './Telegram.svelte';
import Email from './Email.svelte';

/** What a connect component is given. The host is reached through the two verbs, never through the client. */
export type ConnectProps = {
	/** The declared channel, not the transport. */
	channel: string;
	/** The last state the host published; `null` while the first read is in flight. */
	connection: ChannelConnection | null;
	/** Pairs: `{ credential }` for a token-shaped provider, `{ phone }` for one that texts a code. Either may be omitted. */
	pair: (input?: Json) => Promise<void>;
	/** Unpairs: the credential is destroyed and the provider forgets this host. */
	unpair: () => Promise<void>;
	/** A pairing this page is waiting on: the provider may not take two, so its own button disables on this. */
	busy: boolean;
	/** The host's refusal, verbatim — a provider names what is wrong, and replacing that throws it away. */
	error: string | null;
	/** The page's translator. */
	t: (key: string) => string;
};

/** A connect component, loaded the same way whether it is bolt's own or the workspace's: one lazy module. */
export type ConnectLoader = () => Promise<{ default: Component<ConnectProps> }>;

/** Bolt's own providers, by transport. A workspace's file replaces the entry for its channel, not this one. */
const BUILTIN: Readonly<Record<string, Component<ConnectProps>>> = { whatsapp: WhatsApp, telegram: Telegram, email: Email };

/**
 * The one place a channel's connect component is chosen: the workspace's own file for that channel, else bolt's for the
 * channel's transport, else nothing to pair. Both branches return the same loader, so the caller renders one thing.
 */
export function connectOf(channel: string, transport: string, workspace: Readonly<Record<string, ConnectLoader>> | undefined): ConnectLoader | null {
	const own = workspace?.[channel];
	if (own !== undefined) return own;
	const builtin = BUILTIN[transport];
	return builtin === undefined ? null : async () => ({ default: builtin });
}

/** The state line every provider's frame shows, so two providers never word the same state differently. */
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
