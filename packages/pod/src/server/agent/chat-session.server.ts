import { v7 } from 'uuid';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { withCollectionTransaction } from '$lib/server/collection/collection_transaction.server.js';
import { emitSyncOutboxRow } from '$lib/server/collection/sync/sync-outbox.server.js';
import type {
	ChatSessionAggregate,
	ChatSessionMessage,
	ChatSessionTurn
} from '$lib/shared/agent/context-window.js';
import type { AiMessage } from '@norbital-ai/platform-utils/runtime/binding';
import {
	chat_session,
	ChatSessionMessageSchema,
	ChatSessionMessagesSchema,
	ChatSessionTurnSchema,
	ChatSessionTurnsSchema
} from '@norbital-ai/platform-utils/system/workspace-schema';

export type MutableChatSessionAggregate = {
	-readonly [K in keyof ChatSessionAggregate]: ChatSessionAggregate[K];
} & {
	messages: ChatSessionMessage[];
	turns: ChatSessionTurn[];
};

/** Read the one tenant row that owns a conversation and every part in it. */
export async function readChatSession(sessionId: string): Promise<MutableChatSessionAggregate> {
	const ctx = getWorkspace({ provision: true });
	const db = ctx.drizzleDb;
	if (!db) throw new Error('Tenant database is not provisioned');
	const row = (
		await db
			.select({
				...getTableColumns(chat_session),
				norbital_row_version: sql<number>`COALESCE(${chat_session.norbital_row_version}, 0)`
			})
			.from(chat_session)
			.where(eq(chat_session.norbital_id, sessionId))
			.limit(1)
	)[0];
	if (!row) throw new Error('Chat session does not exist');
	return {
		...row,
		messages: ChatSessionMessagesSchema.parse(row.messages ?? []),
		turns: ChatSessionTurnsSchema.parse(row.turns ?? [])
	};
}

/**
 * Serialize one aggregate mutation and publish exactly one chat_session sync event in the same
 * transaction. This is the only write boundary for messages and turns: no dual writes, polling, or
 * ordering repair exists elsewhere.
 */
export async function mutateChatSession<T>(
	sessionId: string,
	mutate: (session: MutableChatSessionAggregate) => T | Promise<T>
): Promise<T> {
	const ctx = getWorkspace({ provision: true });
	return withCollectionTransaction(ctx, async () => {
		const db = ctx.drizzleDb;
		if (!db) throw new Error('Tenant database is not provisioned');
		const row = (
			await db
				.select({
					...getTableColumns(chat_session),
					norbital_row_version: sql<number>`COALESCE(${chat_session.norbital_row_version}, 0)`
				})
				.from(chat_session)
				.where(eq(chat_session.norbital_id, sessionId))
				.for('update')
		)[0];
		if (!row) throw new Error('Chat session does not exist');
		const session: MutableChatSessionAggregate = {
			...row,
			messages: ChatSessionMessagesSchema.parse(row.messages ?? []),
			turns: ChatSessionTurnsSchema.parse(row.turns ?? [])
		};
		const result = await mutate(session);
		const updated = await db
			.update(chat_session)
			.set({
				title: session.title,
				messages: session.messages,
				turns: session.turns,
				usage_cost_usd: session.usage_cost_usd,
				usage_total_tokens: session.usage_total_tokens,
				usage_turns_counted: session.usage_turns_counted,
				usage_turns_unreported: session.usage_turns_unreported,
				norbital_updated_at: new Date()
			})
			.where(eq(chat_session.norbital_id, sessionId))
			.returning({ norbital_row_version: chat_session.norbital_row_version });
		const version = updated[0]?.norbital_row_version;
		if (typeof version !== 'number')
			throw new Error('Chat session update did not return a version');
		await emitSyncOutboxRow(ctx.tenantDb, 'chat_session', 'update', sessionId, version);
		return result;
	});
}

function pushChatMessage(
	session: MutableChatSessionAggregate,
	turnId: string,
	message: AiMessage,
	extra: Readonly<Record<string, unknown>> = {}
): string {
	const id = v7();
	const lastSequence = session.messages.at(-1)?.seq ?? 0;
	session.messages.push({
		norbital_id: id,
		turn_id: turnId,
		role: message.role,
		seq: lastSequence + 1,
		parts: [message],
		model: typeof extra.model === 'string' ? extra.model : null,
		usage:
			extra.usage && typeof extra.usage === 'object' && !Array.isArray(extra.usage)
				? (extra.usage as Readonly<Record<string, unknown>>)
				: null,
		plan_mode: extra.plan_mode === true,
		goal_mode: extra.goal_mode === true,
		kind:
			extra.kind === 'reasoning' ||
			extra.kind === 'summary' ||
			extra.kind === 'usage' ||
			extra.kind === 'goal'
				? extra.kind
				: 'normal',
		status: extra.status === 'streaming' || extra.status === 'aborted' ? extra.status : 'complete',
		queue_status:
			extra.queue_status === 'queued' ||
			extra.queue_status === 'released' ||
			extra.queue_status === 'removed'
				? extra.queue_status
				: 'live',
		release_mode:
			extra.release_mode === 'step' || extra.release_mode === 'turn' ? extra.release_mode : null,
		author_display_name:
			typeof extra.author_display_name === 'string' ? extra.author_display_name : null,
		source_provider: typeof extra.source_provider === 'string' ? extra.source_provider : null,
		source_conversation_id:
			typeof extra.source_conversation_id === 'string' ? extra.source_conversation_id : null,
		source_message_id: typeof extra.source_message_id === 'string' ? extra.source_message_id : null,
		durable_ordinal: typeof extra.durable_ordinal === 'number' ? extra.durable_ordinal : null
	});
	return id;
}

function pushChatTurn(
	session: MutableChatSessionAggregate,
	input: { readonly model: string; readonly parentTurnId?: string; readonly subagentId?: string }
): string {
	const now = new Date().toISOString();
	const id = v7();
	session.turns.push({
		norbital_id: id,
		prompt_message_id: null,
		status: 'running',
		model: input.model,
		parent_turn_id: input.parentTurnId ?? null,
		subagent_id: input.subagentId ?? null,
		error: null,
		started_at: now,
		heartbeat_at: now,
		ended_at: null,
		usage_settled_at: null
	});
	return id;
}

export async function appendChatMessage(
	sessionId: string,
	turnId: string,
	message: AiMessage,
	extra: Readonly<Record<string, unknown>> = {}
): Promise<string> {
	return mutateChatSession(sessionId, (session) =>
		pushChatMessage(session, turnId, message, extra)
	);
}

export async function updateChatMessage(
	sessionId: string,
	messageId: string,
	values: Readonly<Record<string, unknown>>
): Promise<void> {
	await mutateChatSession(sessionId, (session) => {
		const index = session.messages.findIndex((message) => message.norbital_id === messageId);
		if (index < 0) throw new Error('Chat message does not exist');
		session.messages[index] = ChatSessionMessageSchema.parse({
			...session.messages[index]!,
			...values
		});
	});
}

export async function appendChatTurn(
	sessionId: string,
	input: { readonly model: string; readonly parentTurnId?: string; readonly subagentId?: string }
): Promise<string> {
	return mutateChatSession(sessionId, (session) => pushChatTurn(session, input));
}

/**
 * Persist the root turn, user message, and any system notices in one aggregate write.
 *
 * The hosted start path has a two-second guest budget. Opening those rows as separate
 * `mutateChatSession` transactions spent that budget on round-trips before admission.
 */
/** Append the root turn and user message onto an in-memory session. */
export function applyOpenedInteractiveTurn(
	session: MutableChatSessionAggregate,
	input: {
		readonly model: string;
		readonly userMessage: string;
		readonly userExtra?: Readonly<Record<string, unknown>>;
		readonly systemMessages?: readonly {
			readonly content: string;
			readonly extra?: Readonly<Record<string, unknown>>;
		}[];
	}
): { readonly turnId: string; readonly inputMessageId: string } {
	const turnId = pushChatTurn(session, { model: input.model });
	const inputMessageId = pushChatMessage(
		session,
		turnId,
		{ role: 'user', content: input.userMessage },
		input.userExtra ?? {}
	);
	const turnIndex = session.turns.findIndex((candidate) => candidate.norbital_id === turnId);
	const turn = session.turns[turnIndex];
	if (turn) {
		session.turns[turnIndex] = { ...turn, prompt_message_id: inputMessageId };
	}
	for (const notice of input.systemMessages ?? []) {
		pushChatMessage(
			session,
			turnId,
			{ role: 'system', content: notice.content },
			notice.extra ?? {}
		);
	}
	return { turnId, inputMessageId };
}

export async function openInteractiveAgentTurn(input: {
	readonly sessionId: string;
	readonly model: string;
	readonly userMessage: string;
	readonly userExtra?: Readonly<Record<string, unknown>>;
	readonly systemMessages?: readonly {
		readonly content: string;
		readonly extra?: Readonly<Record<string, unknown>>;
	}[];
}): Promise<{
	readonly turnId: string;
	readonly inputMessageId: string;
	readonly session: MutableChatSessionAggregate;
}> {
	return mutateChatSession(input.sessionId, (session) => {
		const opened = applyOpenedInteractiveTurn(session, input);
		return { ...opened, session };
	});
}

export async function updateChatTurn(
	sessionId: string,
	turnId: string,
	values: Readonly<Record<string, unknown>>
): Promise<void> {
	await mutateChatSession(sessionId, (session) => {
		const index = session.turns.findIndex((turn) => turn.norbital_id === turnId);
		if (index < 0) throw new Error('Chat turn does not exist');
		session.turns[index] = ChatSessionTurnSchema.parse({
			...session.turns[index]!,
			...values
		});
	});
}

/** Mark a turn that never reached inference so a failed start cannot leave the composer locked. */
export async function failOpenInteractiveTurn(
	sessionId: string,
	turnId: string,
	error: string
): Promise<void> {
	await mutateChatSession(sessionId, (session) => {
		const index = session.turns.findIndex((turn) => turn.norbital_id === turnId);
		const turn = session.turns[index];
		if (!turn || turn.ended_at !== null) return;
		const settledAt = new Date().toISOString();
		session.turns[index] = {
			...turn,
			status: 'failed',
			heartbeat_at: settledAt,
			ended_at: settledAt,
			error
		};
	});
}
