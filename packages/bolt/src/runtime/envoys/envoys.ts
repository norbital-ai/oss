import { Context, Effect, Layer, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import * as Agents from '#lib/runtime/agents/agents.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import { ApprovalConflict } from '#lib/runtime/approvals/approvals.js';
import { PendingApproval } from '#lib/runtime/collections/collections.js';
import type { WhereCompileError } from '#lib/runtime/collections/where.js';
import { Communication } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import * as RateLimits from '#lib/runtime/rate-limits.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import { envoySubject } from '#lib/runtime/identity/static-identity.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { AuthoredRefusal } from '#lib/authoring/refusal.js';
import * as InvocationBudget from '#lib/runtime/budget.js';

/** Carries envoy error through the typed envoys failure channel without losing diagnostic context. */
class EnvoyError extends Schema.TaggedError<EnvoyError>()('Bolt.Envoys.Error', {
	envoy: Schema.NonEmptyString,
	message: Schema.NonEmptyString
}) {
	readonly category = 'envoy' as const;
	readonly retryable = false;
}
export const EnvoyStatus = Schema.Struct({
	envoy: Schema.NonEmptyString,
	registered: Schema.Boolean,
	received: Schema.Number,
	replied: Schema.Number
});
export interface EnvoyStatus extends Schema.Schema.Type<typeof EnvoyStatus> {}

/**
 * One message a host took off a transport, with everything the transport knows about it.
 *
 * Notice what is *not* here: a subject. It used to be the second argument of `receive`, supplied by
 * the caller, and that could never be right — the host holds a socket, not a workspace identity, and
 * `subject` is a `MINTED_IDENTITY` field precisely so nothing outside this runtime decides who a
 * request is. A phone number is a fact about a wire; who that is, and what they may do, is resolved
 * below from the release's own declarations.
 */
export const EnvoyDelivery = Schema.Struct({
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
export interface EnvoyDelivery extends Schema.Schema.Type<typeof EnvoyDelivery> {}

/**
 * What became of one delivery.
 *
 * Every arm is a state the runtime actually reached, and each is reported rather than folded into a
 * failure: a duplicate is not an error, a group message the envoy ignores is not an error, and an
 * unregistered sender on an `authenticated` envoy is the envoy working exactly as declared. Only
 * `answered` ran a model.
 *
 * `no_principal` is gone with the thing it reported. An envoy's authority came from a service row
 * placed in a team, and a workspace that declared no such team got no row — so the envoy refused
 * every message it ever received, which is what field-operations shipped. An envoy carries its
 * declared policies now, so there is no lookup left to come back empty.
 */
const EnvoyOutcome = Schema.Struct({
	status: Schema.Literals(['answered', 'duplicate', 'silent', 'registration_required']),
	envoy: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString,
	/** The reply the sender was given, when one was sent without running a model. */
	text: Schema.optionalKey(Schema.String),
	result: Schema.optionalKey(Agents.TurnResult)
});
export interface EnvoyOutcome extends Schema.Schema.Type<typeof EnvoyOutcome> {}

export type Interface = Readonly<{
	readonly register: (
		effectId: EffectId,
		envoyName: string
	) => Effect.Effect<void, EnvoyError | Database.FacilityError>;
	/** Runs an agent turn, so it inherits every way that turn can fail, including a refused filter. */
	readonly receive: (
		effectId: EffectId,
		envoyName: string,
		delivery: EnvoyDelivery
	) => Effect.Effect<
		EnvoyOutcome,
		| EnvoyError
		| Workspace.WorkspaceLookupError
		| AccessControl.AccessDenied
		| Database.FacilityError
		| Agents.SkillError
		| Agents.ToolNotAllowed
		| ApprovalConflict
		| PendingApproval
		| WhereCompileError
		| RateLimits.RateLimited
		// Inherited from `agents.turn`, which this yields directly: an envoy message *is* a turn,
		// so anything that turn's tools can raise arrives here unchanged. Both are reachable — a
		// tool reaching a collection whose hook refuses, and a turn that delegates hitting the
		// nesting bound — and the delivery below is what makes the first one matter: a refusal has
		// to reach the person who sent the message, not be reported to them as a broken envoy.
		| AuthoredRefusal
		| InvocationBudget.NestingLimitExceeded
	>;
	readonly reply: (
		effectId: EffectId,
		envoyName: string,
		recipient: string,
		payload: Schema.Json
	) => Effect.Effect<void, EnvoyError | Database.FacilityError>;
	readonly status: (
		effectId: EffectId,
		envoyName: string
	) => Effect.Effect<EnvoyStatus, EnvoyError | Database.FacilityError>;
}>;
/** Identifies the envoys service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Envoys');
export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const agents = yield* Agents.Service;
		const identity = yield* Identity.Service;
		const communication = yield* Communication.Service;
		const database = yield* Database.Service;
		const rateLimits = yield* RateLimits.Service;
		const access = yield* AccessControl.Service;
		const tenant = yield* TenantScope.Service;
		const requireEnvoy = Effect.fn('Envoys.requireEnvoy')(function* (envoyName: string) {
			const envoy = workspace.definition.envoys.find(({ name }) => name === envoyName);
			if (envoy === undefined)
				return yield* new EnvoyError({ envoy: envoyName, message: 'Unknown envoy' });
			return envoy;
		});
		/**
		 * Close one claimed message off with what became of it.
		 *
		 * Separate from the claim so the ledger records an *outcome* rather than an intention. It
		 * cannot fail the delivery: the message has been answered by the time this runs, and losing
		 * the audit line is not a reason to tell the sender their message failed — nor to answer it
		 * twice on the redelivery that a raised error would invite.
		 */
		const settle = Effect.fn('Envoys.settle')(function* (
			effectId: EffectId,
			claimed: { readonly rows: ReadonlyArray<unknown> },
			status: string
		) {
			const row = claimed.rows[0];
			const id = row !== null && typeof row === 'object' ? Reflect.get(row, 'id') : undefined;
			if (typeof id !== 'string') return;
			yield* database
				.execute(EffectId.make(`${effectId}:settle`), {
					_tag: 'Query',
					sql: 'update bolt_envoy_inbound set status = $2, answered_at = now() where "id" = $1::uuid',
					parameters: [id, status]
				})
				.pipe(
					Effect.catch((failure) =>
						Effect.logWarning(
							`envoys: could not record the outcome of an inbound message: ${failure.message}`
						)
					)
				);
		});
		return Service.of({
			register: Effect.fn('Envoys.register')(function* (effectId, envoyName) {
				yield* requireEnvoy(envoyName);
				yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'insert into bolt_envoy_registrations (envoy_name) values ($1) on conflict do nothing',
					parameters: [envoyName]
				});
			}),
			receive: Effect.fn('Envoys.receive')(function* (effectId, envoyName, delivery) {
				const envoy = yield* requireEnvoy(envoyName);
				const senderId = delivery.sender?.id;
				const reply = (text: string) =>
					communication.execute(effectId, {
						_tag: 'Send',
						channel: envoy.transport,
						recipient: delivery.conversationId,
						payload: { text }
					});

				/**
				 * A group message the envoy was not addressed by is not for the agent.
				 *
				 * Checked before the claim below, so an ambient message in a busy group costs a
				 * declaration read rather than a row. `disabled` means the agent is not in groups at all;
				 * `mention_or_reply` means it answers when spoken to and stays quiet otherwise.
				 */
				const addressed =
					delivery.conversationKind !== 'group' ||
					(envoy.groupMessages !== 'disabled' &&
						(envoy.groupMessages !== 'mention_or_reply' ||
							delivery.invocation === 'mention' ||
							delivery.invocation === 'reply'));
				if (!addressed)
					return {
						status: 'silent' as const,
						envoy: envoyName,
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
					sql: `insert into bolt_envoy_inbound
					        (envoy_name, external_conversation_id, external_message_id, receipt_key,
					         sender_external_id, sender_display_name, status)
					      values ($1, $2, $3, $4, $5, $6, 'received')
					      on conflict (receipt_key) do nothing
					  returning "id"`,
					parameters: [
						envoyName,
						delivery.conversationId,
						delivery.messageId,
						`${envoyName}:${delivery.conversationId}:${delivery.messageId}`,
						senderId ?? null,
						delivery.sender?.displayName ?? null
					]
				});
				if (claimed.rows[0] === undefined)
					return {
						status: 'duplicate' as const,
						envoy: envoyName,
						conversationId: delivery.conversationId
					};

				/**
				 * Who is speaking — and *only* who. This decides nothing about capability.
				 *
				 * `authenticated` means the envoy answers people who hold an account here, so an
				 * unmatched sender is turned away before a model runs. `public` means it answers anyone,
				 * so nobody is looked up at all.
				 */
				const linked =
					envoy.audience === 'authenticated' && senderId !== undefined
						? yield* identity.accountByTransportIdentity(effectId, envoy.transport, senderId)
						: undefined;
				if (envoy.audience === 'authenticated' && linked === undefined) {
					const text =
						'This agent is available only to registered members. Ask an administrator to verify this ' +
						'number on your workspace account, then send your message again.';
					yield* reply(text);
					yield* settle(effectId, claimed, 'registration_required');
					return {
						status: 'registration_required' as const,
						envoy: envoyName,
						conversationId: delivery.conversationId,
						text
					};
				}

				// The one rule that must not be wrong, named and asserted on in `envoy-subject.ts`:
				// capability is the declaration's, identity becomes the sender's, `admin` is dropped.
				const subject = envoySubject(envoy, tenant.tenantId, linked);

				/**
				 * The envoy's own rate policy, which is its policies' — it declares none of its own.
				 *
				 * Both halves of what the declaration used to carry are here. A `subject`-keyed rule
				 * bounds the envoy as a whole, because an envoy is one subject and its senders therefore
				 * share one bucket by construction; a `sender`-keyed rule gives each outside sender its
				 * own. That is exactly `totalPerMinute` and `perSenderPerMinute`, said once, in the
				 * vocabulary every other limit in the system is already written in.
				 *
				 * After the claim, so a redelivery of a message that was already answered costs a failed
				 * insert rather than an admission; before the turn, so a refusal costs a map lookup
				 * rather than the model run it is protecting.
				 */
				yield* rateLimits.admit(
					'envoys.receive',
					{
						tenantId: subject.tenantId,
						userId: subject.userId,
						sender: senderId
					},
					access.limits(subject)
				);

				/**
				 * The receipt, written unconditionally now that admission is the limiter's answer.
				 *
				 * It used to be the limiter: an `insert … select … where (count) < cap` that admitted and
				 * recorded in one statement, because counting and then inserting lets every message of a
				 * simultaneous burst read the count from before any of them was written. That property
				 * belonged to a per-envoy cap declared on the envoy; the cap is a policy limit now, and
				 * a policy limit is enforced where every other one is. What remains here is a ledger,
				 * which is all `status` ever read it as.
				 */
				yield* database.execute(EffectId.make(`${effectId}:receipt`), {
					_tag: 'Query',
					sql: 'insert into bolt_envoy_receipts (envoy_name, conversation_id, direction, sender_id) values ($1, $2, $3, $4)',
					parameters: [envoyName, delivery.conversationId, 'inbound', senderId ?? 'anonymous']
				});

				const who =
					delivery.sender === undefined
						? `This message arrived on the ${envoy.transport} envoy "${envoyName}" from an unidentified sender.`
						: `This message arrived on the ${envoy.transport} envoy "${envoyName}" from ${
								delivery.sender.displayName ?? 'an unnamed contact'
							} at ${delivery.sender.id}, who ${
								linked === undefined
									? 'holds no account in this workspace'
									: 'is a registered member of this workspace'
							}.`;

				const result = yield* agents.turn(
					effectId,
					subject,
					envoyName,
					`${envoyName}:${delivery.conversationKind}:${delivery.conversationId}`,
					delivery.text,
					who
				);
				yield* communication.execute(effectId, {
					_tag: 'Send',
					channel: envoy.transport,
					recipient: delivery.conversationId,
					payload: result.output
				});
				yield* settle(effectId, claimed, 'answered');
				return {
					status: 'answered' as const,
					envoy: envoyName,
					conversationId: delivery.conversationId,
					result
				};
			}),
			reply: Effect.fn('Envoys.reply')(function* (effectId, envoyName, recipient, payload) {
				const envoy = yield* requireEnvoy(envoyName);
				yield* communication.execute(effectId, {
					_tag: 'Send',
					channel: envoy.transport,
					recipient,
					payload
				});
				yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'insert into bolt_envoy_receipts (envoy_name, conversation_id, direction) values ($1, $2, $3)',
					parameters: [envoyName, recipient, 'outbound']
				});
			}),
			status: Effect.fn('Envoys.status')(function* (effectId, envoyName) {
				yield* requireEnvoy(envoyName);
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: "select exists(select 1 from bolt_envoy_registrations where envoy_name = $1) as registered, count(*) filter (where direction = 'inbound') as received, count(*) filter (where direction = 'outbound') as replied from bolt_envoy_receipts where envoy_name = $1",
					parameters: [envoyName]
				});
				const row = result.rows[0] ?? {};
				const registered =
					typeof row === 'object' && row !== null && Reflect.get(row, 'registered') === true;
				const received =
					typeof row === 'object' && row !== null ? Number(Reflect.get(row, 'received') ?? 0) : 0;
				const replied =
					typeof row === 'object' && row !== null ? Number(Reflect.get(row, 'replied') ?? 0) : 0;
				return { envoy: envoyName, registered, received, replied };
			})
		});
	})
);
