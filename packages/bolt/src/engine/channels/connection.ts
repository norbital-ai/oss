// A channel's connection to its provider (rule 61). The host owns the socket, the credential and the provider's pairing
// ceremony; the workspace declares only `transport`. This is the one shape both sides speak, so a provider bolt ships
// (WhatsApp, Telegram, email) and one a workspace adds are the same code to the shell and to the host: the host publishes
// a `ChannelConnection` and answers `pair`/`unpair`; the shell's connect component for that channel draws whatever
// `pairing.kind` names. Nothing here knows a provider (P18): a Slack or WeChat adapter publishes the same states, and a
// workspace's own transport is one more `pairing.kind`.
import type { Transport } from '../../decl/runtime/names.ts';
import type { Json } from '../../decl/values.ts';
import type { TransportEvent, TransportPort } from '../contracts.ts';
import { isObj } from './store.ts';

/**
 * Where a connection is. `pairing` is the provider asking for something; `reconnecting` is a retry after a drop and is
 * progress, not failure; `error` is the only terminal one and names its own recovery in `error` (rule 61).
 */
export type ConnectionState =
	'unpaired' | 'connecting' | 'pairing' | 'connected' | 'reconnecting' | 'error';

/** What the provider wants from the operator, when it wants something. `value` is the payload to draw (a QR, a code). */
export type Pairing = {
	/**
	 * `qr`: scan `value`; `code`: show `value` for the operator to type; `credential`: collect a secret and send it back;
	 * `form`: collect `fields` and send them back as one object; `oauth`: open `value` (the provider's authorize URL) in a
	 * popup, where the operator signs in; the provider's redirect lands on the channel's `OAUTH_CALLBACK`.
	 */
	kind: 'qr' | 'code' | 'credential' | 'form' | 'oauth';
	value: string | null;
	/** The provider's own deadline for `value` (ISO), when it publishes one. */
	expiresAt?: string;
	/** What to call the field, for `credential` (a Telegram bot token is not "credential"); `oauth`: the sign-in button. */
	label?: string;
	/** `form`: what to collect, sent back as `{ [name]: value }`. */
	fields?: readonly SetupField[];
};

/** Operator-facing text a provider supplies: English, and each framework locale it is written in (the shell picks by locale). */
export type LocalText = string | { readonly en: string; readonly zh?: string };
/** `x` in `locale`, English when it has none. */
export const localText = (x: LocalText, locale: string): string =>
	typeof x === 'string' ? x : locale.startsWith('zh') ? (x.zh ?? x.en) : x.en;
/** One input a provider's setup collects. `secret` is drawn masked and never echoed back in `about`. */
export type SetupField = {
	name: string;
	label: LocalText;
	secret?: boolean;
	hint?: LocalText;
	optional?: boolean;
	/** A choice among these values (the first is the default), instead of free text. */
	options?: readonly { value: string; label: LocalText }[];
};
/**
 * One instruction, in order. `href` is where to do it (the provider's console); `copy` a value to paste there: the
 * channel's `webhookUrl`, or `redirectUrl` (its `OAUTH_CALLBACK`, to register with an OAuth app).
 */
export type SetupStep = { text: LocalText; href?: string; copy?: 'webhookUrl' | 'redirectUrl' };
/** Where a channel's own OAuth sign-in returns, under its webhook URL: the link's `webhook` answers it. */
export const OAUTH_CALLBACK = '/oauth/callback';
/**
 * How a provider is set up, as data the shell renders with no provider-named component (P18). `kind` is what `pair`
 * takes: `form` sends `fields`; `qr`/`code` sends the optional `fields` and then shows what `pairing` publishes; `none`
 * needs nothing. `webhook`: the operator pastes `about.webhookUrl` into the provider.
 */
export type SetupDescription = {
	kind: 'form' | 'qr' | 'code' | 'none';
	steps: readonly SetupStep[];
	fields?: readonly SetupField[];
	webhook?: boolean;
};
/** A provider as the shell offers it: a transport with several (WhatsApp) asks which, by `label`, first. */
export type ProviderChoice = { id: string; label: LocalText; setup: SetupDescription };
/** A connected channel's test send: a short test message, to the handle the operator types in `to` (absent: to the connected account itself). */
export type TestSend = { to?: SetupField };

/** What a host hands a provider to open one channel's link. The credential is sealed by the host, never by the provider. */
export type ChannelOpen = {
	/** The declared channel name: one link per channel, several channels per transport. */
	channel: string;
	/** Import personal activity, including sent messages and provider history. */
	syncOnly?: boolean;
	/** What the last `save` stored, or `null` when unpaired. */
	credential: Json | null;
	/** This channel's own inbound URL on the host, shown to the operator and registered with the provider where it can. */
	webhookUrl: string;
	/** Seals the credential (or destroys it, `null`) in the host's secrets. */
	save(credential: Json | null): Promise<void>;
	/** Inbound messages and delivery events, into the engine. A rejection is a redelivery. */
	emit(event: TransportEvent): Promise<void>;
	/** The connection moved: the host republishes `link.connection()` to the shell. */
	changed(): void;
	/** The fetch to reach the provider with (tests pass a fake). */
	fetch: typeof fetch;
};
/** One channel's live link to its provider: the transport the engine sends through plus the shell's verbs. */
export type ChannelLink = Pick<TransportPort, 'send' | 'typing'> & {
	connection(): ChannelConnection;
	/** The operator's setup input (`SetupDescription`); rejects with the refusal the shell shows verbatim. */
	pair(input: Json): Promise<void>;
	/** Destroys the credential and forgets this host at the provider. */
	unpair(): Promise<void>;
	/** Inbound HTTP on `webhookUrl` and the paths under it (an OAuth callback, a tracking pixel): the signature is checked here. */
	webhook?(req: Request): Promise<Response>;
	/** Host shutdown: close sockets, keep the credential. */
	close(): Promise<void>;
	/** The provider's own test (send, then read it back); absent → bolt sends a short message to the test target. */
	test?(signal: AbortSignal): Promise<void>;
};
/** A provider (`@norbital-ai/providers`), registered by the host. Bolt never names one. */
export type ChannelProvider = ProviderChoice & {
	transport: Transport;
	/** Provider-owned registration UI for this channel mode; credentials and pairing keep the same runtime. */
	describe?(options: { readonly syncOnly: boolean }): Pick<ProviderChoice, 'label' | 'setup'>;
	/** Imports personal messages and history without sending or triggering replies. */
	supportsSync?: boolean;
	/** The provider can send a test message once connected (`POST …/test`). */
	test?: TestSend;
	open(ctx: ChannelOpen): Promise<ChannelLink>;
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
	/** The active provider's id (`twilio` | `baileys` for WhatsApp), once one is chosen. */
	provider?: string;
	/** What the transport can be set up with; the shell asks which when there are several. */
	providers?: readonly ProviderChoice[];
	/** Present when the connected provider can send a test message: the shell offers Test, asking for `to` when it names one. */
	test?: TestSend;
	/**
	 * Facts the connected view shows generically: `webhookUrl`, `address` (email), `botName`, `workspace`/`team` (Slack),
	 * `guilds`/`inviteUrl` (Discord), `account` (WeChat), `from` (Twilio number).
	 */
	about?: Json;
};

const STATES = new Set<ConnectionState>([
	'unpaired',
	'connecting',
	'pairing',
	'connected',
	'reconnecting',
	'error'
]);

/** Decodes a host's answer at the trust boundary. `null` for anything malformed: the adapter's bug, never a page's. */
export function decodeConnection(channel: string, v: Json): ChannelConnection | null {
	if (!isObj(v)) return null;
	const state = v['state'];
	if (typeof state !== 'string' || !STATES.has(state as ConnectionState)) return null;
	const p = isObj(v['pairing']) ? v['pairing'] : null;
	const kind = p === null ? null : p['kind'];
	const pairing: Pairing | null =
		p === null ||
		(kind !== 'qr' &&
			kind !== 'code' &&
			kind !== 'credential' &&
			kind !== 'form' &&
			kind !== 'oauth')
			? null
			: {
					kind,
					value: typeof p!['value'] === 'string' ? p!['value'] : null,
					...(typeof p!['expiresAt'] === 'string' ? { expiresAt: p!['expiresAt'] } : {}),
					...(typeof p!['label'] === 'string' ? { label: p!['label'] } : {}),
					...(Array.isArray(p!['fields']) ? { fields: fieldsOf(p!['fields']) } : {})
				};
	const providers = Array.isArray(v['providers'])
		? v['providers'].flatMap((c): ProviderChoice[] => {
				const label = isObj(c) ? textOf(c['label']) : null;
				if (!isObj(c) || typeof c['id'] !== 'string' || label === null || !isObj(c['setup']))
					return [];
				const s = c['setup'],
					k = s['kind'];
				if (k !== 'form' && k !== 'qr' && k !== 'code' && k !== 'none') return [];
				const steps = (Array.isArray(s['steps']) ? s['steps'] : []).flatMap((x): SetupStep[] => {
					const text = isObj(x) ? textOf(x['text']) : null;
					return !isObj(x) || text === null
						? []
						: [
								{
									text,
									...(typeof x['href'] === 'string' ? { href: x['href'] } : {}),
									...(x['copy'] === 'webhookUrl' || x['copy'] === 'redirectUrl'
										? { copy: x['copy'] }
										: {})
								}
							];
				});
				return [
					{
						id: c['id'],
						label,
						setup: {
							kind: k,
							steps,
							...(Array.isArray(s['fields']) ? { fields: fieldsOf(s['fields']) } : {}),
							...(s['webhook'] === true ? { webhook: true } : {})
						}
					}
				];
			})
		: undefined;
	const test = isObj(v['test'])
		? { ...(isObj(v['test']['to']) ? { to: fieldsOf([v['test']['to']])[0]! } : {}) }
		: undefined;
	return {
		channel: typeof v['channel'] === 'string' ? v['channel'] : channel,
		transport: typeof v['transport'] === 'string' ? v['transport'] : '',
		state: state as ConnectionState,
		pairing,
		stored: v['stored'] === true,
		...(typeof v['pairedAs'] === 'string' ? { pairedAs: v['pairedAs'] } : {}),
		...(typeof v['detail'] === 'string' ? { detail: v['detail'] } : {}),
		...(typeof v['error'] === 'string' ? { error: v['error'] } : {}),
		...(typeof v['provider'] === 'string' ? { provider: v['provider'] } : {}),
		...(providers === undefined ? {} : { providers }),
		...(test === undefined || (isObj(v['test']) && isObj(v['test']['to']) && test.to === undefined)
			? {}
			: { test }),
		...(v['about'] === undefined ? {} : { about: v['about'] })
	};
}
const textOf = (v: Json | undefined): LocalText | null =>
	typeof v === 'string'
		? v
		: isObj(v) && typeof v['en'] === 'string'
			? { en: v['en'], ...(typeof v['zh'] === 'string' ? { zh: v['zh'] } : {}) }
			: null;
const fieldsOf = (v: readonly Json[]): SetupField[] =>
	v.flatMap((f): SetupField[] => {
		const label = isObj(f) ? textOf(f['label']) : null,
			hint = isObj(f) ? textOf(f['hint']) : null;
		return !isObj(f) || typeof f['name'] !== 'string' || label === null
			? []
			: [
					{
						name: f['name'],
						label,
						...(f['secret'] === true ? { secret: true } : {}),
						...(f['optional'] === true ? { optional: true } : {}),
						...(hint === null ? {} : { hint }),
						...(Array.isArray(f['options'])
							? {
									options: f['options'].flatMap((o) => {
										const l = isObj(o) ? textOf(o['label']) : null;
										return isObj(o) && typeof o['value'] === 'string' && l !== null
											? [{ value: o['value'], label: l }]
											: [];
									})
								}
							: {})
					}
				];
	});

/**
 * An adapter's own state, as one of ours. Every host adapter answers this way, so adding a provider is writing one of
 * these rather than teaching the shell a new vocabulary.
 */
export function connection(
	channel: string,
	transport: string,
	state: ConnectionState,
	more: Omit<ChannelConnection, 'channel' | 'transport' | 'state' | 'stored'> & {
		stored?: boolean;
	} = {}
): ChannelConnection {
	return { channel, transport, state, ...more, stored: more.stored ?? false };
}
