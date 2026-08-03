import { z } from 'zod';
import { createRecord, updateRecord } from '$lib/server/collection/collection_ops.server.js';
import { getTenantManifest } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { runWithWorkspaceContext } from '$lib/server/bootstrap/workspace_runtime.js';
import { resolveRequestorBaseScope } from '$lib/server/bootstrap/resolve_workspace.js';
import { channelPrincipalEmail } from '$lib/server/bootstrap/channel_reconcile.server.js';
import { requireRuntimeFacility } from '$lib/server/run/facilities.js';
import { runAgent } from '$lib/server/agent/agent-loop.server.js';
import { channelAgentSpec } from '$lib/server/agent/agent-spec.server.js';
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
	readonly status: 'answered' | 'duplicate' | 'silent';
	readonly channel: string;
	readonly conversationId: string;
	readonly chatId?: string;
	readonly runId?: string;
	readonly text?: string;
	readonly delivered?: boolean;
};

/** How many trailing transcript messages a channel turn replays. */
const CHANNEL_HISTORY_LIMIT = 40;

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
async function withChannelPrincipal<T>(channelKey: string, run: () => Promise<T>): Promise<T> {
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
		run
	);
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
	conversationId: string
): Promise<{ conversationRowId: string; chatId: string }> {
	const ctx = getWorkspace({ provision: true });
	const bindingKey = `${channelKey}:${conversationId}`;
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
			title: `${channelKey} · ${conversationId}`,
			platform: channel.transport,
			visibility: 'channel_dm',
			external_thread_id: conversationId
		},
		{ isElevated: true }
	);
	const chatId = String(session.norbital_id);
	const inserted = await ctx.tenantDb.query<{ norbital_id: string; chat_id: string }>({
		text: `INSERT INTO channel_conversation
		            (channel_key, transport, external_conversation_id, binding_key, chat_id)
		     VALUES ($1, $2, $3, $4, $5::uuid)
		 ON CONFLICT (binding_key) DO NOTHING
		  RETURNING norbital_id, chat_id`,
		values: [channelKey, channel.transport, conversationId, bindingKey, chatId]
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

	return withChannelPrincipal(command.channel, async () => {
		const ctx = getWorkspace({ provision: true });
		const bound = await bindConversation(command.channel, channel, command.conversationId);
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

		try {
			const result = await runAgent({
				automationName: `channel:${command.channel}`,
				sessionId: bound.chatId,
				historyLimit: CHANNEL_HISTORY_LIMIT,
				input: command.text,
				inputMetadata: {
					source_provider: channel.transport,
					source_conversation_id: command.conversationId,
					source_message_id: command.messageId,
					...(command.sender?.displayName
						? { author_display_name: command.sender.displayName }
						: {})
				},
				// The declared `task` is the agent's standing instruction for this channel, so it reaches
				// the model as the last layer of the system prompt; the message is the input. What the
				// spec may reach is not narrowed here — `channelAgentSpec` explains why the channel
				// principal's policy is the whole boundary.
				spec: await channelAgentSpec({ standingInstruction })
			});

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
					...(result.inputMessageId ? { chat_message_id: result.inputMessageId } : {}),
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
