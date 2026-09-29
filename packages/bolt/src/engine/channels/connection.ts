// A channel's connection to its provider (rule 61). The host owns the socket, the credential and the provider's pairing
// ceremony; the workspace declares only `transport`. This is the one shape both sides speak, so a provider bolt ships
// (WhatsApp, Telegram, email) and one a workspace adds are the same code to the shell and to the host: the host publishes
// a `ChannelConnection` and answers `pair`/`unpair`; the shell's connect component for that channel draws whatever
// `pairing.kind` names. Nothing here knows a provider (P18): a Slack or WeChat adapter publishes the same states, and a
// workspace's own transport is one more `pairing.kind`.
import type { Json } from '../../decl/values.ts';
import { isObj } from './store.ts';

/**
 * Where a connection is. `pairing` is the provider asking for something; `reconnecting` is a retry after a drop and is
 * progress, not failure; `error` is the only terminal one and names its own recovery in `error` (rule 61).
 */
export type ConnectionState = 'unpaired' | 'connecting' | 'pairing' | 'connected' | 'reconnecting' | 'error';

/** What the provider wants from the operator, when it wants something. `value` is the payload to draw (a QR, a code). */
export type Pairing = {
	/** `qr`: scan `value`; `code`: show `value` for the operator to type; `credential`: collect a secret and send it back. */
	kind: 'qr' | 'code' | 'credential';
	value: string | null;
	/** The provider's own deadline for `value` (ISO), when it publishes one. */
	expiresAt?: string;
	/** What to call the field, for `credential` (a Telegram bot token is not "credential"). */
	label?: string;
};

/** One channel's connection as the shell shows it. `channel` is the declared name, never a transport. */
export type ChannelConnection = {
	channel: string;
	transport: string;
	state: ConnectionState;
	pairing?: Pairing | null;
	/** The account or address this is connected as, once it is. */
	pairedAs?: string | null;
	/** Operator-readable context for a non-terminal state. */
	detail?: string;
	/** The recovery `error` needs, operator action. */
	error?: string;
	/** A credential is stored, so reconnecting needs no new pairing. */
	stored: boolean;
	/** Anything else the provider publishes: minted addresses, scopes, a bot's username. */
	about?: Json;
};

const STATES = new Set<ConnectionState>(['unpaired', 'connecting', 'pairing', 'connected', 'reconnecting', 'error']);

/** Decodes a host's answer at the trust boundary. `null` for anything malformed: the adapter's bug, never a page's. */
export function decodeConnection(channel: string, v: Json): ChannelConnection | null {
	if (!isObj(v)) return null;
	const state = v['state'];
	if (typeof state !== 'string' || !STATES.has(state as ConnectionState)) return null;
	const p = isObj(v['pairing']) ? v['pairing'] : null;
	const kind = p === null ? null : p['kind'];
	const pairing: Pairing | null = p === null || (kind !== 'qr' && kind !== 'code' && kind !== 'credential') ? null : {
		kind, value: typeof p!['value'] === 'string' ? p!['value'] : null,
		...(typeof p!['expiresAt'] === 'string' ? { expiresAt: p!['expiresAt'] } : {}),
		...(typeof p!['label'] === 'string' ? { label: p!['label'] } : {})
	};
	return {
		channel: typeof v['channel'] === 'string' ? v['channel'] : channel, transport: typeof v['transport'] === 'string' ? v['transport'] : '',
		state: state as ConnectionState, pairing, stored: v['stored'] === true,
		...(typeof v['pairedAs'] === 'string' ? { pairedAs: v['pairedAs'] } : {}),
		...(typeof v['detail'] === 'string' ? { detail: v['detail'] } : {}),
		...(typeof v['error'] === 'string' ? { error: v['error'] } : {}),
		...(v['about'] === undefined ? {} : { about: v['about'] })
	};
}

/**
 * An adapter's own state, as one of ours. Every host adapter answers this way, so adding a provider is writing one of
 * these rather than teaching the shell a new vocabulary.
 */
export function connection(
	channel: string, transport: string, state: ConnectionState,
	more: Omit<ChannelConnection, 'channel' | 'transport' | 'state' | 'stored'> & { stored?: boolean } = {}
): ChannelConnection {
	return { channel, transport, state, ...more, stored: more.stored ?? false };
}
