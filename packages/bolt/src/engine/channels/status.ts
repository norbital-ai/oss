// Delivery status (§5.9): one order for every provider. A message's status is the most advanced kind reported; a
// terminal failure wins over anything after it; an auto-reply is recorded and never moves the status.
import type { DeliveryKind } from '../../decl/runtime/channel.ts';
import type { Json } from '../../decl/values.ts';

export type { DeliveryKind };
/**
 * What a provider reports about one message it sent, keyed by the `providerId` its `send` returned. Replies and
 * auto-replies are not reported: they arrive as inbound messages and bolt classifies them.
 */
export type DeliveryReport = {
	kind: Exclude<DeliveryKind, 'queued' | 'replied' | 'auto_replied'>; at: string; provider: string;
	code?: string; reason?: string; permanent?: boolean; presumed?: boolean; approximate?: boolean;
	/** Bounded to 4 KB by bolt. */
	raw?: Json;
};
const REPORTED: ReadonlySet<string> = new Set(['sent', 'deferred', 'delivered', 'read', 'opened', 'bounced', 'failed', 'complained']);
/** Whether a provider may report `kind` (a delivery event arriving from outside is checked here). */
export const isReported = (kind: string): kind is DeliveryReport['kind'] => REPORTED.has(kind);
/** One entry of a message's timeline (`sys_message.delivery`, oldest first). `reply` is the inbound message's row id. */
export type DeliveryEntry = Omit<DeliveryReport, 'kind'> & { kind: DeliveryKind; reply?: string };

/**
 * A provider's refusal of a send, thrown from `TransportPort.send`: `permanent` (SMTP 5xx, an API 4xx) fails the message
 * at once; otherwise bolt retries it with backoff and records `deferred` (SMTP 4xx). Recognised by `name`, so a copy of
 * this class in another bundle still counts.
 */
export class SendRefused extends Error {
	override readonly name = 'SendRefused';
	readonly code: string | undefined;
	readonly permanent: boolean;
	constructor(message: string, code?: string, permanent = true) { super(message); this.code = code; this.permanent = permanent; }
}
export const sendRefusal = (e: unknown): { message: string; code?: string; permanent: boolean } | null => {
	if (!(e instanceof Error) || e.name !== 'SendRefused') return null;
	const { code, permanent } = e as Partial<SendRefused>;
	return { message: e.message, permanent: permanent !== false, ...(typeof code === 'string' ? { code } : {}) };
};

/** Terminal: nothing after moves the status. `skipped` and `uncertain`-then-failed are bolt's own queue outcomes. */
export const TERMINAL: ReadonlySet<string> = new Set(['bounced', 'failed', 'complained', 'skipped']);
// `sending` and `uncertain` are the queue's: a report after them advances as from `queued` / `sent`.
export const RANK: { readonly [status: string]: number } = { queued: 0, sending: 0, sent: 1, uncertain: 1, deferred: 2, delivered: 3, read: 4, opened: 4, replied: 5 };

/**
 * The status after `kind` is reported on a message at `current`:
 * `queued < sent < deferred < delivered < read | opened < replied`; `bounced`, `failed`, `complained` are terminal (a later
 * `delivered` never overrides a `bounced`); `auto_replied` never changes it; `read` and `opened` do not replace each other.
 */
export function statusAfter(current: string, kind: DeliveryKind): string {
	if (kind === 'auto_replied' || TERMINAL.has(current)) return current;
	if (TERMINAL.has(kind)) return kind;
	return RANK[kind]! > (RANK[current] ?? 0) ? kind : current;
}

/**
 * Whether an inbound mail is an automatic answer, not a person's (RFC 3834 `Auto-Submitted`, and the markers common
 * auto-responders set: `X-Autoreply`, `X-Autorespond`, `Precedence: auto_reply | bulk | junk`, Exchange's
 * "Automatic reply:" subject).
 */
export function isAutoReply(headers: { readonly [name: string]: string }, subject = ''): boolean {
	const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().toLowerCase()]));
	const submitted = h.get('auto-submitted');
	if (submitted !== undefined && submitted !== '' && !submitted.startsWith('no')) return true;
	if (['x-autoreply', 'x-autorespond', 'x-autoresponder', 'x-autoreply-from', 'x-mail-autoreply'].some((k) => h.has(k))) return true;
	if (/^(auto_reply|bulk|junk)$/.test(h.get('precedence') ?? h.get('x-precedence') ?? '')) return true;
	return /^(automatic reply|auto(matic)?[- ]?(reply|response)|out of (the )?office|自动回复)\s*[:：]/i.test(subject.trim());
}
