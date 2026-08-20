import { Context, Effect, Layer, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { Agents } from '../agents/agents.js';
import { AccessControl } from '../access/access-control.js';
import { ApprovalConflict } from '../approvals/approvals.js';
import { PendingApproval } from '../collections/collections.js';
import type { WhereCompileError } from '../collections/where.js';
import { Communication } from '../facilities/services.js';
import { Database } from '../facilities/database.js';
import { Identity } from '../identity/identity.js';
import { channelPrincipalEmail, channelSubject } from './channel-principal.js';
import { Workspace } from '../workspace.js';
import { AuthoredRefusal } from '../../authoring/refusal.js';
import { InvocationBudget } from '../budget.js';

/** Carries channel error through the typed channels failure channel without losing diagnostic context. */
export class ChannelError extends Schema.TaggedError<ChannelError>()('Bolt.Channels.Error', {
	channel: Schema.NonEmptyString,
	message: Schema.NonEmptyString
}) {
	readonly category = 'channel' as const;
	readonly retryable = false;
}
export const ChannelStatus = Schema.Struct({
	channel: Schema.NonEmptyString,
	registered: Schema.Boolean,
	received: Schema.Number,
	replied: Schema.Number
});
export interface ChannelStatus extends Schema.Schema.Type<typeof ChannelStatus> {}

/**
 * One message a host took off a transport, with everything the transport knows about it.
 *
 * Notice what is *not* here: a subject. It used to be the second argument of `receive`, supplied by
 * the caller, and that could never be right — the host holds a socket, not a workspace identity, and
 * `subject` is a `MINTED_IDENTITY` field precisely so nothing outside this runtime decides who a
 * request is. A phone number is a fact about a wire; who that is, and what they may do, is resolved
 * below from the release's own declarations.
 */
export const ChannelDelivery = Schema.Struct({
	/** The transport's own conversation address — a chat id, a group id. */
	conversationId: Schema.NonEmptyString,
	conversationKind: Schema.Literals(['dm', 'group']),
	/**
	 * The transport's own message id, which is what makes a redelivery recognisable.
	 *
	 * It must be the provider's and not one the host minted, or two deliveries of one message get two
	 * ids and the deduplication below silently stops deduplicating.
	 */
	messageId: Schema.NonEmptyString,
	/** How the agent was addressed in a group: directly, by mention, by reply, or not at all. */
	invocation: Schema.Literals(['direct', 'mention', 'reply', 'ambient']),
	text: Schema.String,
	sender: Schema.optionalKey(
		Schema.Struct({
			/** The transport's address for the sender — a JID, a handle. Never an account id. */
			id: Schema.NonEmptyString,
			displayName: Schema.optionalKey(Schema.NonEmptyString)
		})
	)
});
export interface ChannelDelivery extends Schema.Schema.Type<typeof ChannelDelivery> {}

/**
 * What became of one delivery.
 *
 * Every arm is a state the runtime actually reached, and each is reported rather than folded into a
 * failure: a duplicate is not an error, a group message the channel ignores is not an error, and an
 * unregistered sender on an `authenticated` channel is the channel working exactly as declared. Only
 * `answered` ran a model.
 */
export const ChannelOutcome = Schema.Struct({
	status: Schema.Literals([
		'answered',
		'duplicate',
		'silent',
		'registration_required',
		'no_principal'
	]),
	channel: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString,
	/** The reply the sender was given, when one was sent without running a model. */
	text: Schema.optionalKey(Schema.String),
	result: Schema.optionalKey(Agents.TurnResult)
});
export interface ChannelOutcome extends Schema.Schema.Type<typeof ChannelOutcome> {}

export type Interface = Readonly<{
	readonly register: (
		effectId: EffectId,
		channelName: string
	) => Effect.Effect<void, ChannelError | Database.FacilityError>;
	/** Runs an agent turn, so it inherits every way that turn can fail, including a refused filter. */
	readonly receive: (
		effectId: EffectId,
		channelName: string,
		delivery: ChannelDelivery
	) => Effect.Effect<
		ChannelOutcome,
		| ChannelError
		| Workspace.WorkspaceLookupError
		| AccessControl.AccessDenied
		| Database.FacilityError
		| Agents.SkillError
		| Agents.ToolNotAllowed
		| ApprovalConflict
		| PendingApproval
		| WhereCompileError
		// Inherited from `agents.turn`, which this yields directly: a channel message *is* a turn,
		// so anything that turn's tools can raise arrives here unchanged. Both are reachable — a
		// tool reaching a collection whose hook refuses, and a turn that delegates hitting the
		// nesting bound — and the delivery below is what makes the first one matter: a refusal has
		// to reach the person who sent the message, not be reported to them as a broken channel.
		| AuthoredRefusal
		| InvocationBudget.NestingLimitExceeded
	>;
	readonly reply: (
		effectId: EffectId,
		channelName: string,
		recipient: string,
		payload: Schema.Json
	) => Effect.Effect<void, ChannelError | Database.FacilityError | Database.FacilityError>;
	readonly status: (
		effectId: EffectId,
		channelName: string
	) => Effect.Effect<ChannelStatus, ChannelError | Database.FacilityError>;
}>;
/** Identifies the channels service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Channels');
export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const agents = yield* Agents.Service;
		const identity = yield* Identity.Service;
		const communication = yield* Communication.Service;
		const database = yield* Database.Service;
		/** Owns declaration behavior at the channels boundary so validation and typed semantics stay consistent for every caller. */
		const declarations = {
			find: (channelName: string) =>
				workspace.definition.channels.find(({ name }) => name === channelName)
		};
		const requireChannel = Effect.fn('Channels.requireChannel')(function* (channelName: string) {
			const channel = declarations.find(channelName);
			if (channel === undefined)
				return yield* new ChannelError({ channel: channelName, message: 'Unknown channel' });
			return channel;
		});
		/**
		 * Records an inbound message, and refuses it when the channel's declared per-minute caps are full.
		 *
		 * `rateLimits` was declared on the authoring contract and enforced nowhere, which mattered most
		 * exactly where it was used: a `public` channel is reachable by anyone who can message the
		 * transport, and the cap is the only thing between that and an unbounded number of agent turns
		 * billed to the workspace.
		 *
		 * One statement, because two would not be a limiter. Counting and then inserting lets every
		 * message of a simultaneous burst read the count from before any of them was written and all pass;
		 * an `insert … select … where` evaluates both windows and writes the receipt as one operation, and
		 * an empty `returning` is the refusal. It is the receipt that is conditional rather than the turn,
		 * so the ledger the next message counts against is written before the expensive part runs.
		 *
		 * The receipt is written here rather than after the turn for the same reason: a receipt recorded
		 * only on success would count answers, and a channel that is being flooded is a channel whose
		 * turns are failing.
		 */
		const admitInbound = Effect.fn('Channels.admitInbound')(function* (
			effectId: EffectId,
			channel: {
				readonly name: string;
				readonly rateLimits?: {
					readonly perSenderPerMinute: number;
					readonly totalPerMinute: number;
				};
			},
			conversationId: string,
			senderId: string
		) {
			const limits = channel.rateLimits;
			if (limits === undefined) {
				yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'insert into bolt_channel_receipts (channel_name, conversation_id, direction, sender_id) values ($1, $2, $3, $4)',
					parameters: [channel.name, conversationId, 'inbound', senderId]
				});
				return;
			}
			const window = "created_at > now() - interval '1 minute'";
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `insert into bolt_channel_receipts (channel_name, conversation_id, direction, sender_id) select $1, $2, 'inbound', $3 where (select count(*) from bolt_channel_receipts where channel_name = $1 and direction = 'inbound' and sender_id = $3 and ${window}) < $4 and (select count(*) from bolt_channel_receipts where channel_name = $1 and direction = 'inbound' and ${window}) < $5 returning sequence`,
				parameters: [
					channel.name,
					conversationId,
					senderId,
					limits.perSenderPerMinute,
					limits.totalPerMinute
				]
			});
			if (result.rows.length === 0) {
				return yield* new ChannelError({
					channel: channel.name,
					message: `Rate limit reached: this channel admits ${limits.perSenderPerMinute} messages per sender and ${limits.totalPerMinute} in total each minute.`
				});
			}
		});
		/**
		 * Close one claimed message off with what became of it.
		 *
		 * Separate from the claim so the ledger records an *outcome* rather than an intention. It
		 * cannot fail the delivery: the message has been answered by the time this runs, and losing
		 * the audit line is not a reason to tell the sender their message failed — nor to answer it
		 * twice on the redelivery that a raised error would invite.
		 */
		const settle = Effect.fn('Channels.settle')(function* (
			effectId: EffectId,
			claimed: { readonly rows: ReadonlyArray<unknown> },
			status: string
		) {
			const row = claimed.rows[0];
			const id =
				row !== null && typeof row === 'object' ? Reflect.get(row, 'norbital_id') : undefined;
			if (typeof id !== 'string') return;
			yield* database
				.execute(EffectId.make(`${effectId}:settle`), {
					_tag: 'Query',
					sql: 'update bolt_channel_inbound set status = $2, answered_at = now() where "norbital_id" = $1::uuid',
					parameters: [id, status]
				})
				.pipe(
					Effect.catch((failure) =>
						Effect.logWarning(
							`channels: could not record the outcome of an inbound message: ${failure.message}`
						)
					)
				);
		});
		return Service.of({
			register: Effect.fn('Channels.register')(function* (effectId, channelName) {
				yield* requireChannel(channelName);
				yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'insert into bolt_channel_registrations (channel_name) values ($1) on conflict do nothing',
					parameters: [channelName]
				});
			}),
			receive: Effect.fn('Channels.receive')(function* (effectId, channelName, delivery) {
				const channel = yield* requireChannel(channelName);
				const senderId = delivery.sender?.id;
				const reply = (text: string) =>
					communication.execute(effectId, {
						_tag: 'Send',
						channel: channel.transport,
						recipient: delivery.conversationId,
						payload: { text }
					});

				/**
				 * A group message the channel was not addressed by is not for the agent.
				 *
				 * Checked before the claim below, so an ambient message in a busy group costs a
				 * declaration read rather than a row. `disabled` means the agent is not in groups at all;
				 * `mention_or_reply` means it answers when spoken to and stays quiet otherwise.
				 */
				const addressed =
					delivery.conversationKind !== 'group' ||
					(channel.groupMessages !== 'disabled' &&
						(channel.groupMessages !== 'mention_or_reply' ||
							delivery.invocation === 'mention' ||
							delivery.invocation === 'reply'));
				if (!addressed)
					return {
						status: 'silent' as const,
						channel: channelName,
						conversationId: delivery.conversationId
					};

				/**
				 * Claim this message exactly once, before anything expensive happens.
				 *
				 * The claim is the whole duplicate defence and its position is the point: a transport
				 * that redelivers — and every one of them does — costs one failed insert here instead of
				 * one agent run, one bill, and a second answer to a question already answered. An empty
				 * `returning` *is* the duplicate, so no second read is needed to detect one.
				 */
				const claimed = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `insert into bolt_channel_inbound
					        (channel_name, external_conversation_id, external_message_id, receipt_key,
					         sender_external_id, sender_display_name, status)
					      values ($1, $2, $3, $4, $5, $6, 'received')
					      on conflict (receipt_key) do nothing
					  returning "norbital_id"`,
					parameters: [
						channelName,
						delivery.conversationId,
						delivery.messageId,
						`${channelName}:${delivery.conversationId}:${delivery.messageId}`,
						senderId ?? null,
						delivery.sender?.displayName ?? null
					]
				});
				if (claimed.rows[0] === undefined)
					return {
						status: 'duplicate' as const,
						channel: channelName,
						conversationId: delivery.conversationId
					};

				yield* admitInbound(effectId, channel, delivery.conversationId, senderId ?? 'anonymous');

				/**
				 * The principal is what gives this turn any authority at all, so its absence is a refusal.
				 *
				 * Not a fallback, and deliberately not the system subject or an empty-team subject either.
				 * A workspace that declares no team holding this channel's policy has not said what the
				 * channel may do; running anyway would either grant everything or grant nothing while
				 * looking like it worked. `reconcileChannelPrincipals` logs the same condition at deploy,
				 * naming the team that needs declaring, so this is the second time somebody is told.
				 */
				const principal = yield* identity
					.subjectByEmail(effectId, channelPrincipalEmail(channelName))
					.pipe(Effect.catch(() => Effect.succeed(undefined)));
				if (principal === undefined) {
					const text =
						'This agent is not configured yet and cannot answer. An administrator needs to finish setting up its permissions.';
					yield* reply(text);
					return {
						status: 'no_principal' as const,
						channel: channelName,
						conversationId: delivery.conversationId,
						text
					};
				}

				/**
				 * Who is speaking — and *only* who. This decides nothing about capability.
				 *
				 * `authenticated` means the channel answers people who hold an account here, so an
				 * unmatched sender is turned away before a model runs. `public` means it answers anyone,
				 * so nobody is looked up at all.
				 */
				const linked =
					channel.audience === 'authenticated' && senderId !== undefined
						? yield* identity.accountByTransportIdentity(effectId, channel.transport, senderId)
						: undefined;
				if (channel.audience === 'authenticated' && linked === undefined) {
					const text =
						'This agent is available only to registered members. Ask an administrator to verify this ' +
						'number on your workspace account, then send your message again.';
					yield* reply(text);
					yield* settle(effectId, claimed, 'registration_required');
					return {
						status: 'registration_required' as const,
						channel: channelName,
						conversationId: delivery.conversationId,
						text
					};
				}

				// The one rule that must not be wrong, named and asserted on in `channel-principal.ts`:
				// capability stays the principal's, identity becomes the sender's, `admin` is dropped.
				const subject = channelSubject(principal, linked);

				const who =
					delivery.sender === undefined
						? `This message arrived on the ${channel.transport} channel "${channelName}" from an unidentified sender.`
						: `This message arrived on the ${channel.transport} channel "${channelName}" from ${
								delivery.sender.displayName ?? 'an unnamed contact'
							} at ${delivery.sender.id}, who ${
								linked === undefined
									? 'holds no account in this workspace'
									: 'is a registered member of this workspace'
							}.`;

				const result = yield* agents.turn(
					effectId,
					subject,
					channel.agent,
					`${channelName}:${delivery.conversationKind}:${delivery.conversationId}`,
					delivery.text,
					who
				);
				yield* communication.execute(effectId, {
					_tag: 'Send',
					channel: channel.transport,
					recipient: delivery.conversationId,
					payload: result.output
				});
				yield* settle(effectId, claimed, 'answered');
				return {
					status: 'answered' as const,
					channel: channelName,
					conversationId: delivery.conversationId,
					result
				};
			}),
			reply: Effect.fn('Channels.reply')(function* (effectId, channelName, recipient, payload) {
				const channel = yield* requireChannel(channelName);
				yield* communication.execute(effectId, {
					_tag: 'Send',
					channel: channel.transport,
					recipient,
					payload
				});
				yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'insert into bolt_channel_receipts (channel_name, conversation_id, direction) values ($1, $2, $3)',
					parameters: [channelName, recipient, 'outbound']
				});
			}),
			status: Effect.fn('Channels.status')(function* (effectId, channelName) {
				yield* requireChannel(channelName);
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: "select exists(select 1 from bolt_channel_registrations where channel_name = $1) as registered, count(*) filter (where direction = 'inbound') as received, count(*) filter (where direction = 'outbound') as replied from bolt_channel_receipts where channel_name = $1",
					parameters: [channelName]
				});
				const row = result.rows[0] ?? {};
				const registered =
					typeof row === 'object' && row !== null && Reflect.get(row, 'registered') === true;
				const received =
					typeof row === 'object' && row !== null ? Number(Reflect.get(row, 'received') ?? 0) : 0;
				const replied =
					typeof row === 'object' && row !== null ? Number(Reflect.get(row, 'replied') ?? 0) : 0;
				return { channel: channelName, registered, received, replied };
			})
		});
	})
);
export * as Channels from './channels.js';
