import { z } from 'zod';
import { createRecord, updateRecord } from '$lib/server/collection/collection_ops.server.js';
import { getTenantManifest } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { runWithWorkspaceContext } from '$lib/server/bootstrap/workspace_runtime.js';
import { resolveRequestorBaseScope } from '$lib/server/bootstrap/resolve_workspace.js';
import { channelPrincipalEmail } from '$lib/server/bootstrap/channel_reconcile.server.js';
import { requireRuntimeFacility } from '$lib/server/facilities.js';
import { runAgent } from '$lib/server/agent/agent-loop.server.js';
import { channelAgentSpec } from '$lib/server/agent/agent-spec.server.js';
import {
	appendChatMessage,
	appendChatTurn,
	updateChatTurn
} from '$lib/server/agent/chat-session.server.js';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';

type ManifestChannel = NonNullable<NorbitalManifest['channels']>[string];

/**
 * One message a host received on a transport and is handing to the workspace.
 *
 * This is a *host command*, not a route. Verifying that a message really came from Telegram means
 * holding Telegram's secret and checking its signature, and the credential belongs to whoever holds
 * the socket open — so the host authenticates the wire and Pod is handed something already proven.
 * Pod exposes no public inbound endpoint for channels, which is the only shape that does not require
 * inventing a webhook security model per transport inside a tenant that holds no credentials.
 */
export const ChannelInboundSchema = z.object({
	kind: z.literal('channel'),
	action: z.literal('inbound'),
	/** The declared channel key — the filename in `src/channels/+<key>.channel.ts`. */
	channel: z.string().trim().min(1).max(128),
	/** Transport-native conversation address. */
	conversationId: z.string().trim().min(1).max(512),
	conversationKind: z.enum(['dm', 'group']).default('dm'),
	invocation: z.enum(['direct', 'mention', 'reply', 'ambient']).default('direct'),
	/** Transport-native message id. Carries the deduplication, so it must be the provider's own. */
	messageId: z.string().trim().min(1).max(512),
	text: z.string().min(1).max(16_000),
	sender: z
		.object({
			id: z.string().trim().min(1).max(512),
			displayName: z.string().trim().max(255).optional()
		})
		.optional()
});

export type ChannelInboundCommand = z.infer<typeof ChannelInboundSchema>;

export type ChannelInboundOutcome = {
	readonly status: 'answered' | 'duplicate' | 'silent' | 'registration_required' | 'rate_limited';
	readonly channel: string;
	readonly conversationId: string;
	readonly chatId?: string;
	readonly runId?: string;
	readonly text?: string;
	readonly delivered?: boolean;
};

type ResolvedRequestor = NonNullable<Awaited<ReturnType<typeof resolveRequestorBaseScope>>>;

type StoredUserChannel = Readonly<Record<string, unknown>> & {
	readonly type?: unknown;
	readonly verified?: unknown;
};

const REGISTRATION_REQUIRED_MESSAGE =
	'This agent is available only to registered members. Sign in to Norbital and ask an administrator ' +
	'to verify this messaging identity on your existing account, then send your message again.';
const RATE_LIMIT_MESSAGE =
	'This agent is receiving too many messages right now. Please wait a moment and try again.';
const MAX_CONCURRENT_CHANNEL_RUNS = 8;

function declaredChannel(key: string): ManifestChannel {
	const channel = getTenantManifest().channels?.[key];
	if (!channel) {
		const known = Object.keys(getTenantManifest().channels ?? {}).sort();
		throw new Error(
			`Unknown channel "${key}". This workspace declares: ${known.length > 0 ? known.join(', ') : 'none'}.`
		);
	}
	return channel;
}

/**
 * Re-enter the workspace under the channel's own principal.
 *
 * The host command arrives as the host's identity, which is an administrator — running the agent
 * there would make every channel omnipotent and the declared `policy` decorative. Resolving the
 * principal's scope through the same `resolveRequestorBaseScope` an ordinary request uses means the
 * channel gets exactly the enforcement path a signed-in user gets, no more and no less.
 */
async function withChannelPrincipal<T>(
	channelKey: string,
	run: (principal: ResolvedRequestor) => Promise<T>
): Promise<T> {
	const ctx = getWorkspace({ provision: true });
	const email = channelPrincipalEmail(channelKey);
	const found = await ctx.tenantDb.query<{ norbital_id: string }>({
		text: `SELECT norbital_id FROM "user" WHERE lower(email) = lower($1) AND status = 'active' LIMIT 1`,
		values: [email]
	});
	const userId = found.rows[0]?.norbital_id;
	if (!userId) {
		throw new Error(
			`Channel "${channelKey}" has no principal (${email}). Run \`pod migrate\` — channel principals ` +
				'are reconciled from the manifest there, beside the declared policies.'
		);
	}
	const resolved = await resolveRequestorBaseScope({
		tenantDb: ctx.tenantDb,
		organization: ctx.organization,
		userId
	});
	if (!resolved) {
		throw new Error(`Channel "${channelKey}" principal ${email} could not be scoped`);
	}
	// Everything but the requestor is unchanged — same database, same manifest, same organisation — so
	// this replaces the scope rather than rebuilding a context, which would also rebuild the Drizzle
	// client and the table registry for no reason.
	return runWithWorkspaceContext(
		{ ...ctx, baseScope: resolved.baseScope, userOrganizations: [] },
		() => run(resolved)
	);
}

/**
 * Keep the linked person's identity while retaining the channel principal's policy memberships.
 *
 * Policy placeholders such as `${requestor.norbital_id}` therefore point at the contractor, while
 * collection permissions cannot widen to another policy the same person happens to hold in the web
 * app. The declaration remains the capability ceiling.
 */
async function withAuthenticatedChannelRequestor<T>(
	principal: ResolvedRequestor,
	userId: string,
	run: () => Promise<T>
): Promise<T> {
	const ctx = getWorkspace({ provision: true });
	const linked = await resolveRequestorBaseScope({
		tenantDb: ctx.tenantDb,
		organization: ctx.organization,
		userId
	});
	if (!linked) throw new Error(`Linked channel member ${userId} could not be scoped`);
	return runWithWorkspaceContext(
		{
			...ctx,
			baseScope: {
				...linked.baseScope,
				requestor: {
					...linked.baseScope.requestor,
					team_members: principal.baseScope.requestor.team_members
				}
			},
			userOrganizations: []
		},
		run
	);
}

function canonicalTransportIdentity(transport: string, value: string): string {
	const beforeDomain = value.split('@', 1)[0] ?? value;
	if (transport === 'whatsapp' || transport === 'phone') {
		return beforeDomain.replace(/\D/g, '');
	}
	return beforeDomain.trim().toLowerCase();
}

function storedTransportIdentity(transport: string, channel: StoredUserChannel): string | null {
	if (channel.type !== transport || channel.verified !== true) return null;
	const value =
		transport === 'whatsapp' || transport === 'phone'
			? channel.number
			: transport === 'telegram'
				? channel.telegram_user_id
				: transport === 'slack'
					? channel.slack_user_id
					: channel.id;
	return typeof value === 'string' && value.trim() ? value : null;
}

/** Resolve an assigned member by verified transport identity and the profile's declared policy. */
async function linkedChannelMember(
	channel: ManifestChannel,
	senderId: string | undefined
): Promise<string | null> {
	if (!senderId) return null;
	const ctx = getWorkspace({ provision: true });
	const candidates = await ctx.tenantDb.query<{
		norbital_id: string;
		channels: readonly StoredUserChannel[] | null;
	}>({
		text: `SELECT DISTINCT u.norbital_id, u.channels
		         FROM "user" u
		         JOIN team_members tm ON tm.user_id = u.norbital_id
		         JOIN team t ON t.norbital_id = tm.team_id AND t.is_active = true
		         JOIN policy p ON p.norbital_id = t.policy_id AND p.is_active = true
		        WHERE u.status = 'active' AND u.kind = 'human' AND p.key = $1`,
		values: [channel.policy]
	});
	const sought = canonicalTransportIdentity(channel.transport, senderId);
	for (const candidate of candidates.rows) {
		for (const stored of candidate.channels ?? []) {
			const identity = storedTransportIdentity(channel.transport, stored);
			if (identity && canonicalTransportIdentity(channel.transport, identity) === sought) {
				return candidate.norbital_id;
			}
		}
	}
	return null;
}

/**
 * The transcript this conversation continues, created on its first message.
 *
 * `binding_key` carries the uniqueness, so a second message that races the first loses the insert and
 * reads back the row the winner wrote rather than opening a second transcript for the same chat.
 */
async function bindConversation(
	channelKey: string,
	channel: ManifestChannel,
	conversationId: string,
	conversationKind: 'dm' | 'group',
	sender?: { readonly id: string; readonly displayName?: string }
): Promise<{ conversationRowId: string; chatId: string }> {
	const ctx = getWorkspace({ provision: true });
	const bindingKey = `${channelKey}:${conversationKind}:${conversationId}`;
	const existing = await ctx.tenantDb.query<{ norbital_id: string; chat_id: string }>({
		text: `SELECT norbital_id, chat_id FROM channel_conversation WHERE binding_key = $1 LIMIT 1`,
		values: [bindingKey]
	});
	const found = existing.rows[0];
	if (found) return { conversationRowId: found.norbital_id, chatId: found.chat_id };

	const session = await createRecord(
		ctx,
		'chat_session',
		{
			user_id: ctx.baseScope.requestor.norbital_id,
			title:
				conversationKind === 'dm' && sender?.displayName
					? `${channelKey} · ${sender.displayName}`
					: `${channelKey} · ${conversationId}`,
			platform: channel.transport,
			visibility: conversationKind === 'group' ? 'channel_group' : 'channel_dm',
			channel_key: channelKey,
			external_thread_id: conversationId
		},
		{ isElevated: true }
	);
	const chatId = String(session.norbital_id);
	const inserted = await ctx.tenantDb.query<{ norbital_id: string; chat_id: string }>({
		text: `INSERT INTO channel_conversation
		            (channel_key, transport, external_conversation_id, conversation_kind,
		             audience, policy_key, binding_key, chat_id)
		     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid)
		 ON CONFLICT (binding_key) DO NOTHING
		  RETURNING norbital_id, chat_id`,
		values: [
			channelKey,
			channel.transport,
			conversationId,
			conversationKind,
			channel.audience,
			channel.policy,
			bindingKey,
			chatId
		]
	});
	const row = inserted.rows[0];
	if (row) return { conversationRowId: row.norbital_id, chatId: row.chat_id };

	// Lost the race: another delivery bound this conversation first, so its session is the real one
	// and the one just created is unreferenced.
	const winner = await ctx.tenantDb.query<{ norbital_id: string; chat_id: string }>({
		text: `SELECT norbital_id, chat_id FROM channel_conversation WHERE binding_key = $1 LIMIT 1`,
		values: [bindingKey]
	});
	const settled = winner.rows[0];
	if (!settled) throw new Error(`Channel conversation ${bindingKey} could not be bound`);
	return { conversationRowId: settled.norbital_id, chatId: settled.chat_id };
}

async function attachConversationOwner(
	conversationRowId: string,
	chatId: string,
	userId: string
): Promise<void> {
	const ctx = getWorkspace({ provision: true });
	await updateRecord(
		ctx,
		'channel_conversation',
		conversationRowId,
		{ owner_user_id: userId },
		{ isElevated: true }
	);
	await updateRecord(ctx, 'chat_session', chatId, { user_id: userId }, { isElevated: true });
}

async function consumeRateLimit(bucketKey: string, requestsPerMinute: number): Promise<boolean> {
	const ctx = getWorkspace({ provision: true });
	const counted = await ctx.tenantDb.query<{ request_count: number }>({
		text: `INSERT INTO channel_rate_limit (bucket_key, window_started_at, request_count)
		     VALUES ($1, CURRENT_TIMESTAMP, 1)
		 ON CONFLICT (bucket_key) DO UPDATE SET
		             window_started_at = CASE
		               WHEN channel_rate_limit.window_started_at <=
		                    CURRENT_TIMESTAMP - interval '1 minute'
		               THEN CURRENT_TIMESTAMP ELSE channel_rate_limit.window_started_at END,
		             request_count = CASE
		               WHEN channel_rate_limit.window_started_at <=
		                    CURRENT_TIMESTAMP - interval '1 minute'
		               THEN 1 ELSE channel_rate_limit.request_count + 1 END,
		             norbital_updated_at = CURRENT_TIMESTAMP
		 RETURNING request_count`,
		values: [bucketKey]
	});
	return (counted.rows[0]?.request_count ?? requestsPerMinute + 1) <= requestsPerMinute;
}

async function channelAdmissionAllowed(input: {
	readonly channelKey: string;
	readonly senderId: string | undefined;
	readonly receiptId: string;
	readonly limits: NonNullable<ManifestChannel['rateLimits']> | undefined;
}): Promise<boolean> {
	if (!input.limits) return true;
	const senderKey = input.senderId ?? 'anonymous';
	const senderAllowed = await consumeRateLimit(
		`channel:${input.channelKey}:sender:${senderKey}`,
		input.limits.perSenderPerMinute
	);
	const profileAllowed = await consumeRateLimit(
		`channel:${input.channelKey}:profile`,
		input.limits.totalPerMinute
	);
	const ctx = getWorkspace({ provision: true });
	const active = await ctx.tenantDb.query<{ count: string }>({
		text: `SELECT count(*)::text AS count
		         FROM channel_inbound_message
		        WHERE channel_key = $1 AND status = 'received' AND norbital_id <> $2::uuid`,
		values: [input.channelKey, input.receiptId]
	});
	return (
		senderAllowed &&
		profileAllowed &&
		Number(active.rows[0]?.count ?? 0) < MAX_CONCURRENT_CHANNEL_RUNS
	);
}

async function sendDeterministicReply(input: {
	readonly command: ChannelInboundCommand;
	readonly channel: ManifestChannel;
	readonly chatId: string;
	readonly receiptId: string;
	readonly status: 'registration_required' | 'rate_limited';
	readonly text: string;
}): Promise<ChannelInboundOutcome> {
	// Admission replies still belong to the transcript: administrators must be able to audit every
	// message sent to a profile, including turns where no model was allowed to run.
	const turnId = await appendChatTurn(input.chatId, { model: 'platform/channel-admission' });
	const inputMessageId = await appendChatMessage(
		input.chatId,
		turnId,
		{ role: 'user', content: input.command.text },
		{
			source_provider: input.channel.transport,
			source_conversation_id: input.command.conversationId,
			source_message_id: input.command.messageId,
			...(input.command.sender?.displayName
				? { author_display_name: input.command.sender.displayName }
				: {})
		}
	);
	await updateChatTurn(input.chatId, turnId, { prompt_message_id: inputMessageId });
	await appendChatMessage(input.chatId, turnId, { role: 'assistant', content: input.text });
	await updateChatTurn(input.chatId, turnId, {
		status: 'succeeded',
		ended_at: new Date().toISOString()
	});
	const messaging = requireRuntimeFacility('messaging');
	const delivered = await messaging.sendVia(input.command.channel, input.channel.transport, {
		conversationId: input.command.conversationId,
		text: input.text
	});
	const ctx = getWorkspace({ provision: true });
	await updateRecord(
		ctx,
		'channel_inbound_message',
		input.receiptId,
		{
			status: input.status,
			answered_at: new Date().toISOString(),
			session_message_id: inputMessageId,
			...(delivered.sent ? {} : { error: delivered.reason ?? 'transport refused delivery' })
		},
		{ isElevated: true }
	);
	return {
		status: input.status,
		channel: input.command.channel,
		conversationId: input.command.conversationId,
		text: input.text,
		delivered: delivered.sent
	};
}

/**
 * Claim the right to process this message exactly once.
 *
 * Returns `null` when the receipt already exists, which is the whole duplicate defence: the claim
 * happens before the model is called, so a redelivery costs one failed insert instead of one agent
 * run, one bill, and one second answer to a question already answered.
 */
async function claimInbound(input: {
	readonly channelKey: string;
	readonly conversationRowId: string;
	readonly conversationId: string;
	readonly messageId: string;
	readonly sender?: { readonly id: string; readonly displayName?: string };
}): Promise<string | null> {
	const ctx = getWorkspace({ provision: true });
	const claimed = await ctx.tenantDb.query<{ norbital_id: string }>({
		text: `INSERT INTO channel_inbound_message
		            (channel_key, conversation_id, external_conversation_id, external_message_id,
		             receipt_key, sender_external_id, sender_display_name, status)
		     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, 'received')
		 ON CONFLICT (receipt_key) DO NOTHING
		  RETURNING norbital_id`,
		values: [
			input.channelKey,
			input.conversationRowId,
			input.conversationId,
			input.messageId,
			`${input.channelKey}:${input.conversationId}:${input.messageId}`,
			input.sender?.id ?? null,
			input.sender?.displayName ?? null
		]
	});
	return claimed.rows[0]?.norbital_id ?? null;
}

/**
 * Inbound message → agent turn → reply on the same wire.
 *
 * The declared channel supplies three things the message does not: which policy the agent answers
 * under, which transport the reply leaves by, and what the agent is for. Everything else — who sent
 * it, which conversation, which message — is the transport's, and is stored so a redelivery is
 * recognised and a follow-up question continues the same transcript.
 */
export async function deliverChannelMessage(
	command: ChannelInboundCommand
): Promise<ChannelInboundOutcome> {
	const channel = declaredChannel(command.channel);
	const standingInstruction =
		channel.task ?? `Answer messages arriving on the ${command.channel} channel.`;
	// The transport is read before the principal is resolved: a workspace whose host lost the wire
	// should fail saying so, rather than after a model call whose answer has nowhere to go.
	const messaging = requireRuntimeFacility('messaging');

	return withChannelPrincipal(command.channel, async (principal) => {
		const ctx = getWorkspace({ provision: true });
		const bound = await bindConversation(
			command.channel,
			channel,
			command.conversationId,
			command.conversationKind,
			command.sender
		);
		const receiptId = await claimInbound({
			channelKey: command.channel,
			conversationRowId: bound.conversationRowId,
			conversationId: command.conversationId,
			messageId: command.messageId,
			...(command.sender ? { sender: command.sender } : {})
		});
		if (!receiptId) {
			return {
				status: 'duplicate',
				channel: command.channel,
				conversationId: command.conversationId,
				chatId: bound.chatId
			};
		}
		const groupInvocationAllowed =
			command.conversationKind !== 'group' ||
			channel.groupMessages !== 'mention_or_reply' ||
			command.invocation === 'mention' ||
			command.invocation === 'reply';
		if (
			(command.conversationKind === 'group' && channel.groupMessages === 'disabled') ||
			!groupInvocationAllowed
		) {
			await updateRecord(
				ctx,
				'channel_inbound_message',
				receiptId,
				{ status: 'ignored', answered_at: new Date().toISOString() },
				{ isElevated: true }
			);
			return {
				status: 'silent',
				channel: command.channel,
				conversationId: command.conversationId,
				chatId: bound.chatId
			};
		}
		if (
			!(await channelAdmissionAllowed({
				channelKey: command.channel,
				senderId: command.sender?.id,
				receiptId,
				limits: channel.audience === 'public' ? channel.rateLimits : undefined
			}))
		) {
			return {
				...(await sendDeterministicReply({
					command,
					channel,
					chatId: bound.chatId,
					receiptId,
					status: 'rate_limited',
					text: RATE_LIMIT_MESSAGE
				})),
				chatId: bound.chatId
			};
		}

		const linkedUserId =
			channel.audience === 'authenticated'
				? await linkedChannelMember(channel, command.sender?.id)
				: null;
		if (channel.audience === 'authenticated' && !linkedUserId) {
			return {
				...(await sendDeterministicReply({
					command,
					channel,
					chatId: bound.chatId,
					receiptId,
					status: 'registration_required',
					text: REGISTRATION_REQUIRED_MESSAGE
				})),
				chatId: bound.chatId
			};
		}
		if (linkedUserId && command.conversationKind === 'dm') {
			await attachConversationOwner(bound.conversationRowId, bound.chatId, linkedUserId);
		}

		try {
			const run = async () =>
				runAgent({
					automationName: `channel:${command.channel}`,
					sessionId: bound.chatId,
					input: command.text,
					inputMetadata: {
						source_provider: channel.transport,
						source_conversation_id: command.conversationId,
						source_message_id: command.messageId,
						source_conversation_kind: command.conversationKind,
						...(command.invocation ? { source_invocation: command.invocation } : {}),
						...(command.sender?.displayName
							? { author_display_name: command.sender.displayName }
							: {})
					},
					// The declared `task` is the agent's standing instruction for this channel, so it reaches
					// the model as the last layer of the system prompt; the message is the input. Collection
					// reach is the channel principal's policy; host tools are only those the channel named.
					spec: await channelAgentSpec({
						standingInstruction,
						...(channel.hostTools && channel.hostTools.length > 0
							? { hostTools: channel.hostTools }
							: {}),
						...(channel.hostSandbox ? { hostSandbox: channel.hostSandbox } : {})
					})
				});
			const result = linkedUserId
				? await withAuthenticatedChannelRequestor(principal, linkedUserId, run)
				: await run();

			const text = result.text.trim();
			// An empty answer is not an error and must not be sent: transports reject an empty body, and
			// a run that only called tools legitimately has nothing to say.
			const delivered = text
				? await messaging.sendVia(command.channel, channel.transport, {
						conversationId: command.conversationId,
						text
					})
				: { sent: false, reason: 'agent produced no text' };

			await updateRecord(
				ctx,
				'channel_inbound_message',
				receiptId,
				{
					status: 'answered',
					...(result.inputMessageId ? { session_message_id: result.inputMessageId } : {}),
					answered_at: new Date().toISOString(),
					...(delivered.sent ? {} : { error: delivered.reason ?? 'transport refused delivery' })
				},
				{ isElevated: true }
			);
			await updateRecord(
				ctx,
				'channel_conversation',
				bound.conversationRowId,
				{
					last_inbound_at: new Date().toISOString(),
					...(delivered.sent ? { last_outbound_at: new Date().toISOString() } : {})
				},
				{ isElevated: true }
			);

			return {
				status: text ? 'answered' : 'silent',
				channel: command.channel,
				conversationId: command.conversationId,
				chatId: bound.chatId,
				runId: result.runId,
				text,
				delivered: delivered.sent
			};
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			// The receipt stays claimed. A crashed turn already had side effects, so replaying it on the
			// next redelivery is worse than leaving a `failed` row that says what happened.
			await updateRecord(
				ctx,
				'channel_inbound_message',
				receiptId,
				{ status: 'failed', error: message },
				{ isElevated: true }
			).catch(() => undefined);
			throw cause;
		}
	});
}
