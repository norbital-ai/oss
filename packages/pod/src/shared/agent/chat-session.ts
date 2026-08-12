import type { AiMessage } from '@norbital-ai/platform-utils/runtime/binding';

/** One durable message embedded in its tenant-owned chat_session aggregate. */
export type ChatSessionMessage = {
	readonly norbital_id: string;
	readonly turn_id: string | null;
	readonly role: string;
	readonly seq: number;
	readonly parts: readonly AiMessage[];
	readonly model: string | null;
	readonly usage: Readonly<Record<string, unknown>> | null;
	readonly plan_mode: boolean;
	readonly kind: 'normal' | 'reasoning' | 'summary' | 'usage';
	readonly status: 'streaming' | 'complete' | 'aborted';
	readonly queue_status: 'live' | 'queued' | 'released' | 'removed';
	readonly release_mode: 'step' | 'turn' | null;
	readonly author_user_id: string | null;
	readonly author_display_name: string | null;
	readonly source_provider: string | null;
	readonly source_conversation_id: string | null;
	readonly source_message_id: string | null;
	readonly source_deleted_at: string | null;
};

/** One root or delegated provider turn embedded beside the messages it owns. */
export type ChatSessionTurn = {
	readonly norbital_id: string;
	readonly prompt_message_id: string | null;
	readonly status: 'running' | 'succeeded' | 'aborted' | 'failed';
	readonly model: string;
	readonly parent_turn_id: string | null;
	readonly subagent_id: string | null;
	readonly error: string | null;
	readonly started_at: string;
	readonly heartbeat_at: string;
	readonly ended_at: string | null;
	readonly usage_settled_at: string | null;
};

export type ChatSessionAggregate = {
	readonly norbital_id: string;
	readonly norbital_row_version: number;
	readonly title: string;
	readonly messages: readonly ChatSessionMessage[];
	readonly turns: readonly ChatSessionTurn[];
	readonly usage_cost_usd: number;
	readonly usage_total_tokens: number;
	readonly usage_turns_counted: number;
	readonly usage_turns_unreported: number;
};
