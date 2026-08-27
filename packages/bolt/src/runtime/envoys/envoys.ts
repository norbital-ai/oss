import { Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { and, asc, count, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { EnvoyDefinition } from '#lib/authoring/contracts-schema.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as Agents from '#lib/runtime/agents/agents.js';
import * as ChatDocuments from '#lib/runtime/agents/documents.js';
import {
	chatDocumentStorageKey,
	type ChatAttachment,
	type InboundBatchMessage,
	type StoredInboundBatch
} from '#lib/runtime/agents/chat-messages.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import { ApprovalConflict } from '#lib/runtime/approvals/approvals.js';
import { PendingApproval } from '#lib/runtime/collections/collections.js';
import type { WhereCompileError } from '#lib/runtime/collections/where.js';
import { Communication } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import * as RateLimits from '#lib/runtime/rate-limits.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import { envoyPrincipalId, envoySubject } from '#lib/runtime/identity/static-identity.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { AuthoredRefusal } from '#lib/authoring/refusal.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import { composer, dbNow, dbNowPlusSeconds, executeBuilt } from '#lib/runtime/persistence.js';

const {
	chat_session: chatSession,
	bolt_envoy_inbound: boltEnvoyInbound,
	bolt_envoy_receipts: boltEnvoyReceipts,
	bolt_envoy_registrations: boltEnvoyRegistrations
} = SYSTEM_MODEL_TABLES;

class EnvoyError extends Schema.TaggedError<EnvoyError>()('Bolt.Envoys.Error', {
	envoy: Schema.NonEmptyString,
	message: Schema.NonEmptyString
}) {
	readonly category = 'envoy' as const;
	readonly retryable = false;
}

const EnvoyStatus = Schema.Struct({
	envoy: Schema.NonEmptyString,
	registered: Schema.Boolean,
	received: Schema.Number,
	replied: Schema.Number
});
interface EnvoyStatus extends Schema.Schema.Type<typeof EnvoyStatus> {}

const MAX_INBOUND_ATTACHMENTS = 8;
const MAX_INBOUND_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_INBOUND_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_INBOUND_ATTACHMENT_BYTES / 3) * 4;
const InboundAttachment = Schema.Struct({
	provider: Schema.NonEmptyString,
	attachmentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	mimeType: Schema.Literals(['image/jpeg', 'image/png']),
	fileName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	byteLength: Schema.Number.check(
		Schema.isInt(),
		Schema.isBetween({ minimum: 1, maximum: MAX_INBOUND_ATTACHMENT_BYTES })
	),
	bytesBase64: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_INBOUND_ATTACHMENT_BASE64_LENGTH),
		Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
	)
});

/** One message a host took off a transport, containing wire facts and no claimed authority. */
export const EnvoyDelivery = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	conversationKind: Schema.Literals(['dm', 'group']),
	messageId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	sentAt: Schema.String.check(
		Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
	),
	invocation: Schema.Literals(['direct', 'mention', 'reply', 'ambient']),
	text: Schema.String,
	attachments: Schema.Array(InboundAttachment).check(
		Schema.makeFilter(
			(attachments) =>
				attachments.length <= MAX_INBOUND_ATTACHMENTS ||
				`at most ${MAX_INBOUND_ATTACHMENTS} inbound attachments are accepted`
		)
	),
	sender: Schema.optionalKey(
		Schema.Struct({
			id: Schema.NonEmptyString,
			displayName: Schema.optionalKey(Schema.NonEmptyString)
		})
	)
});
export interface EnvoyDelivery extends Schema.Schema.Type<typeof EnvoyDelivery> {}

const EnvoyOutcome = Schema.Struct({
	status: Schema.Literals(['buffered', 'duplicate', 'silent', 'registration_required']),
	envoy: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString,
	text: Schema.optionalKey(Schema.String)
});
interface EnvoyOutcome extends Schema.Schema.Type<typeof EnvoyOutcome> {}

const DrainReport = Schema.Struct({
	envoy: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString,
	drained: Schema.Number,
	status: Schema.Literals(['queued', 'answered', 'failed', 'skipped'])
});
interface DrainReport extends Schema.Schema.Type<typeof DrainReport> {}

const DRAIN_DEBOUNCE_MS = 3_000;
const DRAIN_LEASE_SECONDS = 120;
const MAX_DRAIN_MESSAGES = 32;
const REGISTRATION_NOTICE_LIMITS = {
	'envoys.registration': [{ window: '1 hour', limit: 1, key: 'sender' as const }]
};

const InboundRow = Schema.Struct({
	id: Schema.NonEmptyString,
	conversation_id: Schema.NonEmptyString,
	transport_conversation_id: Schema.NonEmptyString,
	external_message_id: Schema.NonEmptyString,
	sender_external_id: Schema.NullOr(Schema.String),
	sender_display_name: Schema.NullOr(Schema.String),
	sent_at: Schema.NonEmptyString,
	invocation: Schema.Literals(['direct', 'mention', 'reply', 'ambient']),
	text: Schema.String,
	attachments: Schema.Array(
		Schema.Struct({
			provider: Schema.NonEmptyString,
			attachmentId: Schema.NonEmptyString,
			file: Schema.Struct({
				storage_key: Schema.NonEmptyString,
				file_name: Schema.NonEmptyString,
				file_size: Schema.Number,
				mime_type: Schema.NonEmptyString
			})
		})
	),
	subject: Identity.Subject,
	addressed: Schema.Boolean
});
type InboundRow = Schema.Schema.Type<typeof InboundRow>;
const decodeInboundRow = Schema.decodeUnknownOption(InboundRow);
const IdRow = Schema.Struct({ id: Schema.NonEmptyString });
const decodeIdRow = Schema.decodeUnknownOption(IdRow);
/** The transport address a turn in flight answers on, and the envoy that declared it. */
const ProcessingRecipient = Schema.Struct({
	id: Schema.NonEmptyString,
	envoy_name: Schema.NonEmptyString,
	transport_conversation_id: Schema.NonEmptyString
});

type EnvoyFailure =
	| EnvoyError
	| Workspace.WorkspaceLookupError
	| AccessControl.AccessDenied
	| Database.FacilityError
	| ChatDocuments.ChatDocumentError
	| Agents.SkillError
	| Agents.ToolNotAllowed
	| ApprovalConflict
	| PendingApproval
	| WhereCompileError
	| RateLimits.RateLimited
	| AuthoredRefusal
	| InvocationBudget.NestingLimitExceeded;

export type Interface = Readonly<{
	readonly register: (
		effectId: EffectId,
		envoyName: string
	) => Effect.Effect<void, EnvoyError | Database.FacilityError>;
	readonly receive: (
		effectId: EffectId,
		envoyName: string,
		delivery: EnvoyDelivery
	) => Effect.Effect<EnvoyOutcome, EnvoyFailure>;
	readonly drain: (
		effectId: EffectId,
		envoyName: string,
		conversationId: string
	) => Effect.Effect<DrainReport, EnvoyFailure>;
	readonly complete: (
		effectId: EffectId,
		envoyName: string,
		conversationId: string,
		output: Schema.Json,
		/**
		 * The provider key of this turn's progress bubble, when one is on the wire. The answer edits
		 * that bubble in place, so one conversation turn stays one message; when the edit cannot
		 * land, the answer is sent fresh — compactness never outranks the answer arriving.
		 */
		progressKey: string | null
	) => Effect.Effect<DrainReport, EnvoyError | Database.FacilityError>;
	readonly reply: (
		effectId: EffectId,
		envoyName: string,
		recipient: string,
		payload: Schema.Json
	) => Effect.Effect<void, EnvoyError | Database.FacilityError>;
	/**
	 * Posts or rewrites one compact progress note on this conversation's transport.
	 *
	 * Best effort by contract: a conversation that is not a transport one — the web agent's — has
	 * nothing in flight to post on and answers `null`, and so does a transport that refused. The
	 * returned key is the bubble to edit next; an edit that landed keeps the key it was given,
	 * because rewriting a message does not change which message it is.
	 */
	readonly progress: (
		effectId: EffectId,
		conversationId: string,
		body: string,
		updateOf: string | null
	) => Effect.Effect<string | null, EnvoyError | Database.FacilityError>;
	readonly status: (
		effectId: EffectId,
		envoyName: string
	) => Effect.Effect<EnvoyStatus, EnvoyError | Database.FacilityError>;
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/Envoys');

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const agents = yield* Agents.Service;
		const documents = yield* ChatDocuments.Service;
		const identity = yield* Identity.Service;
		const communication = yield* Communication.Service;
		const database = yield* Database.Service;
		const queue = yield* TaskQueue.Service;
		const rateLimits = yield* RateLimits.Service;
		const access = yield* AccessControl.Service;
		const tenant = yield* TenantScope.Service;

		const requireEnvoy = Effect.fn('Envoys.requireEnvoy')(function* (envoyName: string) {
			const envoy = workspace.definition.envoys.find(({ name }) => name === envoyName);
			if (envoy === undefined)
				return yield* new EnvoyError({ envoy: envoyName, message: 'Unknown envoy' });
			return envoy;
		});

		const bytesOf = (base64: string): Uint8Array => {
			const binary = atob(base64);
			return Uint8Array.from(binary, (character) => character.charCodeAt(0));
		};

		const releaseLease = (effectId: EffectId, conversationId: string) =>
			executeBuilt(
				effectId,
				database,
				composer
					.update(chatSession)
					.set({ drain_lease_until: null })
					.where(eq(chatSession.conversation_id, conversationId))
			);

		const enqueueDrain = Effect.fn('Envoys.enqueueDrain')(function* (
			effectId: EffectId,
			envoyName: string,
			conversationId: string,
			now: number
		) {
			const bucket = Math.floor(now / DRAIN_DEBOUNCE_MS);
			const taskId = `envoys.drain:${conversationId}:${bucket}`;
			yield* queue.enqueue(effectId, [
				{
					command: 'envoys.drain',
					input: { envoy: envoyName, conversationId },
					effectId: taskId,
					runAtEpochMs: now + DRAIN_DEBOUNCE_MS
				}
			]);
		});

		const recordReceipt = (
			effectId: EffectId,
			envoyName: string,
			conversationId: string,
			direction: 'inbound' | 'outbound',
			senderId?: string
		) =>
			executeBuilt(
				effectId,
				database,
				composer.insert(boltEnvoyReceipts).values({
					envoy_name: envoyName,
					conversation_id: conversationId,
					direction,
					sender_id: senderId ?? null
				})
			);

		/**
		 * Delivers one outbound message and reports what it became on the wire.
		 *
		 * The provider key the receipt carries back is what turns a reply into a conversation that
		 * can update itself: progress is one bubble edited in place, and the final answer edits that
		 * same bubble. Never fails — a transport that refused names that in `delivered`, and a
		 * provider that answers no key still delivered, with `key: null` as the honest answer.
		 */
		const deliver = Effect.fn('Envoys.deliver')(function* (
			effectId: EffectId,
			envoy: EnvoyDefinition & { readonly name: string },
			recipient: string,
			payload: Schema.Json,
			updateOf?: string | null
		) {
			const response = yield* communication
				.execute(EffectId.make(`${effectId}:reply`), {
					_tag: 'Send',
					channel: envoy.transport,
					recipient,
					payload:
						updateOf === undefined || updateOf === null
							? payload
							: {
									...(payload !== null && typeof payload === 'object'
										? payload
										: { text: String(payload) }),
									updateOf
								}
				})
				.pipe(Effect.option);
			yield* recordReceipt(
				EffectId.make(`${effectId}:receipt`),
				envoy.name,
				recipient,
				'outbound'
			);
			if (Option.isNone(response)) return { delivered: false as const, key: null };
			const receipt: unknown = response.value.receipt;
			const id =
				receipt !== null && typeof receipt === 'object' ? Reflect.get(receipt, 'id') : undefined;
			return {
				delivered: true as const,
				key: typeof id === 'string' && id !== '' ? id : null
			};
		});

		return Service.of({
			register: Effect.fn('Envoys.register')(function* (effectId, envoyName) {
				yield* requireEnvoy(envoyName);
				yield* executeBuilt(
					effectId,
					database,
					composer
						.insert(boltEnvoyRegistrations)
						.values({ envoy_name: envoyName })
						.onConflictDoNothing({ target: boltEnvoyRegistrations.envoy_name })
				);
			}),

			receive: Effect.fn('Envoys.receive')(function* (effectId, envoyName, delivery) {
				const envoy = yield* requireEnvoy(envoyName);
				const senderId = delivery.sender?.id;
				const groupEnabled =
					delivery.conversationKind !== 'group' || envoy.groupMessages !== 'disabled';
				if (!groupEnabled) {
					return {
						status: 'silent' as const,
						envoy: envoyName,
						conversationId: delivery.conversationId
					};
				}
				const addressed =
					delivery.conversationKind !== 'group' ||
					envoy.groupMessages === 'all' ||
					delivery.invocation === 'mention' ||
					delivery.invocation === 'reply';

				const linked =
					envoy.audience === 'authenticated' && senderId !== undefined
						? yield* identity.accountByTransportIdentity(effectId, envoy.transport, senderId)
						: undefined;
				if (envoy.audience === 'authenticated' && linked === undefined) {
					const principal = envoySubject(envoy, tenant.tenantId, undefined);
					const declared = access.limits(principal);
					const noticeLimits = {
						...declared,
						'envoys.registration':
							declared['envoys.registration'] ?? REGISTRATION_NOTICE_LIMITS['envoys.registration']
					};
					const admitted = yield* rateLimits
						.admit(
							'envoys.registration',
							{
								tenantId: tenant.tenantId,
								userId: envoyPrincipalId(envoyName),
								sender: senderId
							},
							noticeLimits
						)
						.pipe(
							Effect.as(true),
							Effect.catch(() => Effect.succeed(false))
						);
					const text =
						'This agent is available only to registered members. Ask an administrator to verify this ' +
						'number on your workspace account, then send your message again.';
					if (admitted) {
						yield* communication.execute(effectId, {
							_tag: 'Send',
							channel: envoy.transport,
							recipient: delivery.conversationId,
							payload: { text }
						});
					}
					return {
						status: 'registration_required' as const,
						envoy: envoyName,
						conversationId: delivery.conversationId,
						...(admitted ? { text } : {})
					};
				}

				const subject = envoySubject(envoy, tenant.tenantId, linked);
				yield* rateLimits.admit(
					'envoys.receive',
					{
						tenantId: subject.tenantId,
						userId: envoyPrincipalId(envoyName),
						sender: senderId
					},
					access.limits(subject)
				);

				const conversationId = `${envoyName}:${delivery.conversationKind}:${delivery.conversationId}`;
				yield* agents.open(
					EffectId.make(`${effectId}:conversation`),
					subject,
					envoyName,
					conversationId
				);

				const claim = yield* executeBuilt(
					EffectId.make(`${effectId}:claim`),
					database,
					composer
						.insert(boltEnvoyInbound)
						.values({
							envoy_name: envoyName,
							conversation_id: conversationId,
							transport_conversation_id: delivery.conversationId,
							external_message_id: delivery.messageId,
							receipt_key: `${envoyName}:${delivery.conversationId}:${delivery.messageId}`,
							sender_external_id: senderId ?? null,
							sender_display_name: delivery.sender?.displayName ?? null,
							sent_at: delivery.sentAt,
							invocation: delivery.invocation,
							text: delivery.text,
							attachments: JSON.stringify([]),
							subject: JSON.stringify(subject),
							addressed,
							status: 'receiving'
						})
						.onConflictDoNothing({ target: boltEnvoyInbound.receipt_key })
						.returning({ id: boltEnvoyInbound.id })
				);
				const claimed = decodeIdRow(claim.rows[0]);
				if (claimed._tag === 'None') {
					return {
						status: 'duplicate' as const,
						envoy: envoyName,
						conversationId: delivery.conversationId
					};
				}

				const stored: Array<ChatAttachment> = [];
				const finishBuffer = Effect.gen(function* () {
					for (const [index, attachment] of delivery.attachments.entries()) {
						const bytes = bytesOf(attachment.bytesBase64);
						if (bytes.byteLength !== attachment.byteLength) {
							return yield* new EnvoyError({
								envoy: envoyName,
								message: `attachment ${attachment.attachmentId} did not match its declared byte length`
							});
						}
						const storageKey = chatDocumentStorageKey(
							conversationId,
							`${delivery.messageId}:${index}`,
							attachment.fileName
						);
						const file = {
							storage_key: storageKey,
							file_name: attachment.fileName,
							file_size: bytes.byteLength,
							mime_type: attachment.mimeType
						};
						yield* documents.write(
							EffectId.make(`${effectId}:attachment:${index}`),
							conversationId,
							file,
							bytes,
							{
								source: 'envoy',
								messageId: delivery.messageId,
								provider: attachment.provider,
								providerAttachmentId: attachment.attachmentId,
								...(senderId === undefined ? {} : { senderId })
							}
						);
						stored.push({
							provider: attachment.provider,
							attachmentId: attachment.attachmentId,
							file
						});
					}
					yield* executeBuilt(
						EffectId.make(`${effectId}:buffer`),
						database,
						composer
							.update(boltEnvoyInbound)
							.set({ attachments: JSON.stringify(stored), status: 'pending' })
							.where(eq(boltEnvoyInbound.id, claimed.value.id))
					);
					yield* recordReceipt(
						EffectId.make(`${effectId}:receipt`),
						envoyName,
						delivery.conversationId,
						'inbound',
						senderId
					);
					if (addressed) {
						const now = yield* Clock.currentTimeMillis;
						yield* enqueueDrain(
							EffectId.make(`${effectId}:enqueue`),
							envoyName,
							conversationId,
							now
						);
					}
				});
				yield* finishBuffer.pipe(
					Effect.onError(() =>
						Effect.all([
							...stored.map(({ file }, index) =>
								documents.remove(
									EffectId.make(`${effectId}:abandon-document:${index}`),
									conversationId,
									file.storage_key
								)
							),
							executeBuilt(
								EffectId.make(`${effectId}:abandon`),
								database,
								composer.delete(boltEnvoyInbound).where(eq(boltEnvoyInbound.id, claimed.value.id))
							)
						]).pipe(Effect.ignore)
					)
				);
				return {
					status: addressed ? ('buffered' as const) : ('silent' as const),
					envoy: envoyName,
					conversationId: delivery.conversationId
				};
			}),

			drain: Effect.fn('Envoys.drain')(function* (effectId, envoyName, conversationId) {
				const envoy = yield* requireEnvoy(envoyName);
				const lease = yield* executeBuilt(
					EffectId.make(`${effectId}:lease`),
					database,
					composer
						.update(chatSession)
						.set({ drain_lease_until: dbNowPlusSeconds(DRAIN_LEASE_SECONDS) })
						.where(
							and(
								eq(chatSession.conversation_id, conversationId),
								or(
									isNull(chatSession.drain_lease_until),
									lt(chatSession.drain_lease_until, dbNow())
								)
							)
						)
						.returning({ id: chatSession.id })
				);
				if (lease.rows.length === 0) {
					return { envoy: envoyName, conversationId, drained: 0, status: 'skipped' as const };
				}

				const pendingIds = composer
					.select({ id: boltEnvoyInbound.id })
					.from(boltEnvoyInbound)
					.where(
						and(
							eq(boltEnvoyInbound.conversation_id, conversationId),
							eq(boltEnvoyInbound.status, 'pending')
						)
					)
					.orderBy(asc(boltEnvoyInbound.sent_at), asc(boltEnvoyInbound.created_at))
					.limit(MAX_DRAIN_MESSAGES);
				const claimed = yield* executeBuilt(
					EffectId.make(`${effectId}:take`),
					database,
					composer
						.update(boltEnvoyInbound)
						.set({ status: 'processing' })
						.where(inArray(boltEnvoyInbound.id, pendingIds))
						.returning({
							id: boltEnvoyInbound.id,
							conversation_id: boltEnvoyInbound.conversation_id,
							transport_conversation_id: boltEnvoyInbound.transport_conversation_id,
							external_message_id: boltEnvoyInbound.external_message_id,
							sender_external_id: boltEnvoyInbound.sender_external_id,
							sender_display_name: boltEnvoyInbound.sender_display_name,
							sent_at: boltEnvoyInbound.sent_at,
							invocation: boltEnvoyInbound.invocation,
							text: boltEnvoyInbound.text,
							attachments: boltEnvoyInbound.attachments,
							subject: boltEnvoyInbound.subject,
							addressed: boltEnvoyInbound.addressed
						})
				);
				const rows = claimed.rows
					.flatMap((row) => {
						const decoded = decodeInboundRow(row);
						return decoded._tag === 'Some' ? [decoded.value] : [];
					})
					.toSorted((left, right) => left.sent_at.localeCompare(right.sent_at));
				if (rows.length === 0) {
					yield* releaseLease(EffectId.make(`${effectId}:release`), conversationId);
					return { envoy: envoyName, conversationId, drained: 0, status: 'skipped' as const };
				}
				const trigger = [...rows].reverse().find(({ addressed }) => addressed);
				if (trigger === undefined) {
					yield* executeBuilt(
						EffectId.make(`${effectId}:restore`),
						database,
						composer
							.update(boltEnvoyInbound)
							.set({ status: 'pending' })
							.where(
								inArray(
									boltEnvoyInbound.id,
									rows.map(({ id }) => id)
								)
							)
					);
					yield* releaseLease(EffectId.make(`${effectId}:release`), conversationId);
					return { envoy: envoyName, conversationId, drained: 0, status: 'skipped' as const };
				}

				const messages: Array<InboundBatchMessage> = rows.map((row) => ({
					sender: {
						...(row.sender_external_id === null ? {} : { id: row.sender_external_id }),
						...(row.sender_display_name === null ? {} : { displayName: row.sender_display_name })
					},
					sentAt: row.sent_at,
					messageId: row.external_message_id,
					text: row.text,
					attachments: row.attachments,
					invocation: row.invocation
				}));
				const batch: StoredInboundBatch = { kind: 'inbound_batch', messages };
				yield* agents.enqueue(
					effectId,
					trigger.subject,
					envoyName,
					conversationId,
					String(effectId),
					batch
				);
				yield* releaseLease(EffectId.make(`${effectId}:release`), conversationId);

				const remaining = yield* executeBuilt(
					EffectId.make(`${effectId}:remaining`),
					database,
					composer
						.select({ count: count() })
						.from(boltEnvoyInbound)
						.where(
							and(
								eq(boltEnvoyInbound.conversation_id, conversationId),
								eq(boltEnvoyInbound.status, 'pending')
							)
						)
				);
				const left = Number(
					Reflect.get((remaining.rows[0] as object | undefined) ?? {}, 'count') ?? 0
				);
				if (left > 0) {
					const now = yield* Clock.currentTimeMillis;
					yield* enqueueDrain(EffectId.make(`${effectId}:requeue`), envoyName, conversationId, now);
				}
				return { envoy: envoyName, conversationId, drained: rows.length, status: 'queued' as const };
			}),

			complete: Effect.fn('Envoys.complete')(function* (
				effectId,
				envoyName,
				conversationId,
				output,
				progressKey
			) {
				const envoy = yield* requireEnvoy(envoyName);
				const processing = yield* executeBuilt(
					EffectId.make(`${effectId}:processing`),
					database,
					composer
						.select({
							id: boltEnvoyInbound.id,
							envoy_name: boltEnvoyInbound.envoy_name,
							transport_conversation_id: boltEnvoyInbound.transport_conversation_id
						})
						.from(boltEnvoyInbound)
						.where(
							and(
								eq(boltEnvoyInbound.conversation_id, conversationId),
								eq(boltEnvoyInbound.status, 'processing')
							)
						)
						.orderBy(asc(boltEnvoyInbound.sent_at))
				);
				const rows = processing.rows.flatMap((row) => {
					const decoded = Schema.decodeUnknownOption(ProcessingRecipient)(row);
					return decoded._tag === 'Some' ? [decoded.value] : [];
				});
				if (rows.length === 0)
					return { envoy: envoyName, conversationId, drained: 0, status: 'skipped' as const };
				const recipient = rows.at(-1)?.transport_conversation_id;
				let answered = false;
				if (recipient !== undefined) {
					// The turn's progress bubble is edited into the answer when one is on the wire; when
					// that edit cannot land — the bubble was never sent, or the transport lost it — the
					// answer is sent fresh. One bubble per turn is the aim, never at the cost of the answer.
					if (progressKey !== null) {
						answered = (yield* deliver(effectId, envoy, recipient, output, progressKey)).delivered;
					}
					if (!answered) {
						answered = (yield* deliver(effectId, envoy, recipient, output)).delivered;
					}
				}
				const status = answered ? ('answered' as const) : ('failed' as const);
				yield* executeBuilt(
					EffectId.make(`${effectId}:settle`),
					database,
					composer
						.update(boltEnvoyInbound)
						.set({ status, answered_at: dbNow() })
						.where(inArray(boltEnvoyInbound.id, rows.map(({ id }) => id)))
				);
				return { envoy: envoyName, conversationId, drained: rows.length, status };
			}),

			reply: Effect.fn('Envoys.reply')(function* (effectId, envoyName, recipient, payload) {
				const envoy = yield* requireEnvoy(envoyName);
				yield* deliver(effectId, envoy, recipient, payload);
			}),

			progress: Effect.fn('Envoys.progress')(function* (effectId, conversationId, body, updateOf) {
				const processing = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({
							envoy_name: boltEnvoyInbound.envoy_name,
							transport_conversation_id: boltEnvoyInbound.transport_conversation_id
						})
						.from(boltEnvoyInbound)
						.where(
							and(
								eq(boltEnvoyInbound.conversation_id, conversationId),
								eq(boltEnvoyInbound.status, 'processing')
							)
						)
						.orderBy(asc(boltEnvoyInbound.sent_at))
						.limit(1)
				);
				const decoded = Schema.decodeUnknownOption(ProcessingRecipient)(processing.rows[0]);
				// A conversation with nothing in flight is not a transport one: the web agent's turns
				// land here, and progress has nowhere to be posted. Silence is the correct answer.
				if (decoded._tag === 'None') return null;
				const envoy = yield* requireEnvoy(decoded.value.envoy_name);
				const outcome = yield* deliver(
					effectId,
					envoy,
					decoded.value.transport_conversation_id,
					{ text: body, progress: true },
					updateOf
				);
				if (!outcome.delivered) return null;
				// An edit that landed rewrites the very message `updateOf` names, so the key to edit
				// next is the key that was handed in; only a fresh send mints a new one.
				return outcome.key ?? updateOf;
			}),

			status: Effect.fn('Envoys.status')(function* (effectId, envoyName) {
				yield* requireEnvoy(envoyName);
				const registration = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({ envoy_name: boltEnvoyRegistrations.envoy_name })
						.from(boltEnvoyRegistrations)
						.where(eq(boltEnvoyRegistrations.envoy_name, envoyName))
						.limit(1)
				);
				const receivedRows = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({ count: count() })
						.from(boltEnvoyReceipts)
						.where(
							and(
								eq(boltEnvoyReceipts.envoy_name, envoyName),
								eq(boltEnvoyReceipts.direction, 'inbound')
							)
						)
				);
				const repliedRows = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({ count: count() })
						.from(boltEnvoyReceipts)
						.where(
							and(
								eq(boltEnvoyReceipts.envoy_name, envoyName),
								eq(boltEnvoyReceipts.direction, 'outbound')
							)
						)
				);
				return {
					envoy: envoyName,
					registered: registration.rows.length === 1,
					received: Number(
						Reflect.get((receivedRows.rows[0] as object | undefined) ?? {}, 'count') ?? 0
					),
					replied: Number(
						Reflect.get((repliedRows.rows[0] as object | undefined) ?? {}, 'count') ?? 0
					)
				};
			})
		});
	})
);
