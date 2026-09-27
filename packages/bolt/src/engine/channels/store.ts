// The channel rows (rule 61, §5.9 "messages are rows"): inbound history, the outbox and envoy transcripts are
// `sys_message` rows in a `sys_conversation` (one per provider chat or mail thread), the system models the agents area
// shares. A declared-channel notice's delivery run is queued by the engine's trigger (`engine/schema/engine.ts`).
import { createHash } from 'node:crypto';
import type { Json } from '../../decl/values.ts';

/** The platform run that sends a channel notice to each member it names (rule 47). */
export const NOTIFY = 'notifications.deliver';

/** Stable ids: a redelivery of the same provider message is the same row (rule 61: deduplicated by `(channel, provider_id)`). */
export const stableId = (...parts: readonly string[]): string => {
	const h = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
export const conversationId = (channel: string, thread: string): string => stableId('conversation', channel, thread);
export const messageId = (channel: string, providerId: string): string => stableId('message', channel, providerId);

/** A list shows `preview` (≤ 2 KiB); the agent area's rule. */
export { preview } from '../agent/schema.ts';

export const sql = (text: string, ...params: Json[]) => ({ text, params });
export type Obj = { readonly [k: string]: Json };
export const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
