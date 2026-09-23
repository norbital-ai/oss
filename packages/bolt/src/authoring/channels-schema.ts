import { Schema } from 'effect';
import {
	TRANSPORTS,
	type ChatEnvelope,
	type ChatMessage,
	type EmailEnvelope,
	type EmailMessage,
	type HttpDelivery,
	type HttpRequest,
	type InboxMessage,
	type NotificationRecipient,
	type Transport
} from '@norbital-ai/bolt-protocol';
import type { WorkspaceChannelAuthoringTypes } from './authoring-types.js';
import type {
	AnySchema,
	DefaultWorkspaceSchema,
	HttpConnection,
	MutationInsertFor,
	PolicyName,
	SchemaRow,
	TableName,
	WebhookSignatureSpec
} from './contracts-schema.js';

export type { Transport };

/** The outbound message a transport takes. */
export type MessageFor<T extends Transport> = T extends 'email'
	? EmailMessage
	: T extends 'whatsapp' | 'telegram'
		? ChatMessage
		: T extends 'inbox'
			? InboxMessage
			: HttpRequest;

/** The inbound envelope a transport delivers. */
export type EnvelopeFor<T extends Transport> = T extends 'email'
	? EmailEnvelope
	: T extends 'http'
		? HttpDelivery
		: ChatEnvelope;

/**
 * The declared channels, read off the augmentation `bolt sync` writes.
 *
 * A separate interface from `WorkspaceAuthoringTypes` for the reason `TeamName` has one: a channel
 * file's `outbound` rules are typed against the workspace schema, so folding the channels map into
 * the schema's own augmentation would make the schema depend on itself.
 */
type DeclaredChannels = WorkspaceChannelAuthoringTypes extends {
	readonly channels: infer C extends Readonly<Record<string, { readonly transport: Transport }>>;
}
	? C
	: Readonly<Record<string, { readonly transport: Transport }>>;

/** Every declared channel, by its `src/channels/+<name>.ts` file. */
export type ChannelName = keyof DeclaredChannels & string;
export type TransportOf = { readonly [N in ChannelName]: DeclaredChannels[N]['transport'] };
type Augmented = WorkspaceChannelAuthoringTypes extends { readonly channels: unknown } ? true : false;
/** The channels that can reach a person: `api.notify` and collection notification rules. */
export type PersonChannel = Augmented extends true
	? {
			[N in ChannelName]: TransportOf[N] extends 'inbox' | 'email' | 'whatsapp' | 'telegram' ? N : never;
		}[ChannelName]
	: string;
/** The channels an envoy can hold a conversation on. */
export type ConversationChannel = Augmented extends true
	? {
			[N in ChannelName]: TransportOf[N] extends 'email' | 'whatsapp' | 'telegram' ? N : never;
		}[ChannelName]
	: string;

/** `api.channels.<name>.send`, one entry per declared channel, typed by its transport. */
export type ChannelsApi = {
	readonly [N in ChannelName]: {
		readonly send: (
			message: MessageFor<TransportOf[N]>
		) => import('effect').Effect.Effect<{ readonly outboxId: string }>;
	};
};

export type NotifyInput = Readonly<{
	/** The notification's durable identity: one key is one notification however often it is stated. */
	readonly key: string;
	readonly recipients: ReadonlyArray<NotificationRecipient>;
	readonly title: string;
	readonly body: string;
	/** Required and non-empty: no delivery is implied. */
	readonly via: readonly [PersonChannel, ...PersonChannel[]];
}>;

/** `api.notify` exists only when the workspace declares a channel that can reach a person. */
export type NotifyApi = [PersonChannel] extends [never]
	? {}
	: { readonly notify: (notification: NotifyInput) => import('effect').Effect.Effect<void> };

type OutboundTrigger<S extends AnySchema, N extends TableName<S>> =
	| 'create'
	| 'update'
	| 'delete'
	| {
			readonly create?: (context: { readonly record: SchemaRow<S, N> }) => boolean;
			readonly update?: (context: {
				readonly previous: SchemaRow<S, N>;
				readonly record: SchemaRow<S, N>;
			}) => boolean;
			readonly delete?: (context: { readonly record: SchemaRow<S, N> }) => boolean;
	  };

/**
 * One outbound rule: a write to `from` sends a message on this channel.
 *
 * The message is built on the write path and committed to the channel outbox in the write's own
 * transaction, so a message means "this happened", and a crash after the commit leaves a queued
 * send, never a lost one. Pure and synchronous, like every per-record function on the write path.
 */
export type OutboundRule<S extends AnySchema, T extends Transport, N extends TableName<S>> = {
	readonly from: N;
	readonly on: OutboundTrigger<S, N>;
	readonly message: (context: {
		readonly record: SchemaRow<S, N>;
		readonly previous?: SchemaRow<S, N>;
	}) => MessageFor<T>;
};

type Patch<S extends AnySchema, N extends TableName<S>> = Partial<MutationInsertFor<S, N>>;

/**
 * What the provider reports back about a message an outbound rule sent, as one patch on the record
 * that caused it. Only that record, and only the fields returned; `undefined` records nothing.
 */
export type ChannelEvents<S extends AnySchema, T extends Transport, N extends TableName<S>> = {
	readonly delivered?: (event: { readonly at: string }) => Patch<S, N> | undefined;
	readonly bounced?: (event: { readonly at: string; readonly reason: string }) => Patch<S, N> | undefined;
	readonly opened?: (event: { readonly at: string }) => Patch<S, N> | undefined;
	readonly failed?: (event: { readonly at: string; readonly reason: string }) => Patch<S, N> | undefined;
	readonly replied?: (event: {
		readonly at: string;
		readonly mail: EnvelopeFor<T>;
	}) => Patch<S, N> | undefined;
};

export type ChannelDefinition<
	T extends Transport = Transport,
	S extends AnySchema = DefaultWorkspaceSchema,
	N extends TableName<S> = TableName<S>
> = {
	readonly transport: T;
	/** An email channel's local part (defaults to the channel name); the host mints the address. */
	readonly address?: T extends 'email' ? string : never;
	/** An `http` channel's endpoint. */
	readonly connection?: T extends 'http' ? HttpConnection : never;
	/** An `http` channel that also receives: how a delivery proves it came from the source. */
	readonly webhook?: T extends 'http'
		? { readonly signature: WebhookSignatureSpec; readonly eventIdHeader?: string }
		: never;
	/** The authority outbound rules read and event patches write under. Required with either. */
	readonly policies?: ReadonlyArray<PolicyName>;
	readonly outbound?: Readonly<Record<string, OutboundRule<S, T, N>>>;
	readonly events?: ChannelEvents<S, T, N>;
};

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/**
 * Declares one channel: an instance of a transport. The file key is its name.
 *
 * Validation runs at module load, so a malformed channel fails `bolt sync` naming its file.
 */
export const defineChannel = <
	const T extends Transport,
	S extends AnySchema = DefaultWorkspaceSchema,
	const N extends TableName<S> = TableName<S>
>(
	declaration: ChannelDefinition<T, S, N>
): ChannelDefinition<T, S, N> => {
	validateChannel('channel', declaration);
	return declaration;
};

/** The serialisable half of a channel: what the runtime, the manifest and the host read. */
export interface ChannelDeclaration {
	readonly name: string;
	readonly transport: Transport;
	readonly address?: string;
	readonly connection?: HttpConnection;
	readonly webhook?: { readonly signature: WebhookSignatureSpec; readonly eventIdHeader?: string };
	readonly policies: ReadonlyArray<string>;
	readonly outbound: ReadonlyArray<{
		readonly name: string;
		readonly from: string;
		readonly events: ReadonlyArray<'create' | 'update' | 'delete'>;
	}>;
	readonly events: ReadonlyArray<'delivered' | 'bounced' | 'opened' | 'failed' | 'replied'>;
}

/** The live half: the functions that cannot cross a manifest. */
export interface AuthoredChannel {
	readonly outbound: Readonly<
		Record<
			string,
			{
				readonly from: string;
				readonly matches: (
					operation: 'create' | 'update' | 'delete',
					record: Readonly<Record<string, unknown>>,
					previous?: Readonly<Record<string, unknown>>
				) => boolean;
				readonly message: (context: {
					readonly record: Readonly<Record<string, unknown>>;
					readonly previous?: Readonly<Record<string, unknown>>;
				}) => unknown;
			}
		>
	>;
	readonly events: Readonly<
		Partial<Record<'delivered' | 'bounced' | 'opened' | 'failed' | 'replied', (event: never) => unknown>>
	>;
}

const OPERATIONS = ['create', 'update', 'delete'] as const;
const EVENT_KINDS = ['delivered', 'bounced', 'opened', 'failed', 'replied'] as const;
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;

const validateChannel = (name: string, declaration: unknown): void => {
	if (!isRecord(declaration)) throw new TypeError(`Channel ${name} must default-export defineChannel({ transport }).`);
	const transport = declaration['transport'];
	if (typeof transport !== 'string' || !(TRANSPORTS as ReadonlyArray<string>).includes(transport))
		throw new TypeError(`Channel ${name} names transport ${JSON.stringify(transport)}; the transports are ${TRANSPORTS.join(', ')}.`);
	const address = declaration['address'];
	if (address !== undefined && (transport !== 'email' || typeof address !== 'string' || !LOCAL_PART.test(address)))
		throw new TypeError(`Channel ${name}: \`address\` is an email channel's lower-case local part (a-z, 0-9, -).`);
	if (transport === 'http' && !isRecord(declaration['connection']))
		throw new TypeError(`Channel ${name}: an http channel requires a connection.`);
	if (transport !== 'http' && (declaration['connection'] !== undefined || declaration['webhook'] !== undefined))
		throw new TypeError(`Channel ${name}: only an http channel takes a connection or a webhook.`);
	const outbound = declaration['outbound'];
	const events = declaration['events'];
	const policies = declaration['policies'];
	if ((outbound !== undefined || events !== undefined) && (!Array.isArray(policies) || policies.length === 0))
		throw new TypeError(`Channel ${name} declares outbound rules or events, so it must name the policies they run under.`);
	if (transport === 'inbox' && (outbound !== undefined || events !== undefined))
		throw new TypeError(`Channel ${name}: an inbox channel is reached through api.notify and notification rules, not outbound rules.`);
	if (outbound !== undefined) {
		if (!isRecord(outbound)) throw new TypeError(`Channel ${name}: outbound maps rule names to rules.`);
		for (const [rule, value] of Object.entries(outbound)) {
			if (!isRecord(value) || typeof value['from'] !== 'string' || typeof value['message'] !== 'function')
				throw new TypeError(`Channel ${name}: outbound.${rule} needs { from, on, message }.`);
			const on = value['on'];
			if (!(typeof on === 'string' ? (OPERATIONS as ReadonlyArray<string>).includes(on) : isRecord(on)))
				throw new TypeError(`Channel ${name}: outbound.${rule}.on is 'create' | 'update' | 'delete' or a predicate map.`);
		}
	}
	if (events !== undefined) {
		if (!isRecord(events)) throw new TypeError(`Channel ${name}: events maps event kinds to patch builders.`);
		for (const [kind, handler] of Object.entries(events)) {
			if (!(EVENT_KINDS as ReadonlyArray<string>).includes(kind) || typeof handler !== 'function')
				throw new TypeError(`Channel ${name}: events.${kind} is not an event kind (${EVENT_KINDS.join(', ')}).`);
			if (kind === 'replied' && transport !== 'email')
				throw new TypeError(`Channel ${name}: only an email channel reports replies.`);
		}
		if (outbound === undefined)
			throw new TypeError(`Channel ${name}: events patch the record an outbound rule sent from, so they need an outbound rule.`);
	}
};

const operationsOf = (on: unknown): ReadonlyArray<'create' | 'update' | 'delete'> =>
	typeof on === 'string'
		? [on as 'create' | 'update' | 'delete']
		: OPERATIONS.filter((operation) => isRecord(on) && on[operation] !== undefined);

/** Splits one authored channel into its declaration and its live half. */
export const describeChannel = (
	name: string,
	declaration: unknown
): { readonly declaration: ChannelDeclaration; readonly authored: AuthoredChannel } => {
	validateChannel(name, declaration);
	const value = declaration as ChannelDefinition<Transport, AnySchema, string>;
	const outbound = Object.entries(value.outbound ?? {});
	return {
		declaration: Object.freeze({
			name,
			transport: value.transport,
			...(value.transport === 'email' ? { address: value.address ?? name.replaceAll('_', '-') } : {}),
			...(value.connection === undefined ? {} : { connection: value.connection }),
			...(value.webhook === undefined ? {} : { webhook: value.webhook }),
			policies: Object.freeze([...(value.policies ?? [])]),
			outbound: outbound.map(([rule, spec]) => ({
				name: rule,
				from: spec.from,
				events: operationsOf(spec.on)
			})),
			events: EVENT_KINDS.filter((kind) => value.events?.[kind] !== undefined)
		}),
		authored: {
			outbound: Object.fromEntries(
				outbound.map(([rule, spec]) => [
					rule,
					{
						from: spec.from,
						matches: (operation, record, previous) => {
							const on = spec.on;
							if (typeof on === 'string') return on === operation;
							const predicate = on[operation] as
								| ((context: Readonly<Record<string, unknown>>) => boolean)
								| undefined;
							if (predicate === undefined) return false;
							return operation === 'update'
								? predicate({ previous: previous ?? {}, record })
								: predicate({ record });
						},
						message: spec.message as AuthoredChannel['outbound'][string]['message']
					}
				])
			),
			events: { ...(value.events ?? {}) } as AuthoredChannel['events']
		}
	};
};
