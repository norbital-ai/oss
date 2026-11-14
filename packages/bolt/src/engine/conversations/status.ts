// Delivery status: one order for every provider. A message's status is the most advanced kind reported; a
// terminal failure wins over anything after it; an auto-reply is recorded and never moves the status.
import type { DeliveryKind } from '../../decl/runtime/integration.ts';
import { Predicate } from 'effect';
import { REPORTED_KINDS, type DeliveryReport } from '@norbital-ai/host-api';

export type { DeliveryKind };
const REPORTED: ReadonlySet<string> = new Set(REPORTED_KINDS);
/** Whether a provider may report `kind` (a delivery event arriving from outside is checked here). */
export const is_reported = (kind: string): kind is DeliveryReport['kind'] => REPORTED.has(kind);
/** One entry of a message's timeline (`sys_message.delivery`, oldest first). `reply` is the inbound message's row id. */
export type DeliveryEntry = Omit<DeliveryReport, 'kind'> & { kind: DeliveryKind; reply?: string };

export const sendRefusal = (
	e: unknown
): { message: string; code?: string; permanent: boolean } | null => {
	if (!(e instanceof Error) || e.name !== 'SendRefused') return null;
	const code = Predicate.hasProperty(e, 'code') ? e.code : undefined;
	const permanent = Predicate.hasProperty(e, 'permanent') ? e.permanent : undefined;
	return {
		message: e.message,
		permanent: permanent !== false,
		...(typeof code === 'string' ? { code } : {})
	};
};

/** Terminal: nothing after moves the status. `skipped` and `uncertain`-then-failed are bolt's own queue outcomes. */
export const TERMINAL: ReadonlySet<string> = new Set([
	'bounced',
	'failed',
	'complained',
	'skipped'
]);
// `sending` and `uncertain` are the queue's: a report after them advances as from `queued` / `sent`.
export const RANK: { readonly [status: string]: number } = {
	queued: 0,
	sending: 0,
	sent: 1,
	uncertain: 1,
	deferred: 2,
	delivered: 3,
	read: 4,
	opened: 4,
	replied: 5
};

/** Accepted outbound messages remain context when later delivery and reply reports advance them. */
export const confirmed_send = (status: string | null | undefined): boolean =>
	status != null && status !== 'uncertain' && !TERMINAL.has(status) && (RANK[status] ?? 0) >= 1;

/**
 * The status after `kind` is reported on a message at `current`:
 * `queued < sent < deferred < delivered < read | opened < replied`; `bounced`, `failed`, `complained` are terminal (a later
 * `delivered` never overrides a `bounced`); `auto_replied` never changes it; `read` and `opened` do not replace each other.
 */
export function status_after(current: string, kind: DeliveryKind): string {
	if (kind === 'auto_replied' || TERMINAL.has(current)) return current;
	if (TERMINAL.has(kind)) return kind;
	const rank = RANK[kind];
	return rank !== undefined && rank > (RANK[current] ?? 0) ? kind : current;
}

/**
 * Whether an inbound mail is an automatic answer, not a person's (RFC 3834 `Auto-Submitted`, and the markers common
 * auto-responders set: `X-Autoreply`, `X-Autorespond`, `Precedence: auto_reply | bulk | junk`, Exchange's
 * "Automatic reply:" subject).
 */
export function is_auto_reply(headers: { readonly [name: string]: string }, subject = ''): boolean {
	const h = new Map(
		Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().toLowerCase()])
	);
	const submitted = h.get('auto-submitted');
	if (submitted !== undefined && submitted !== '' && !submitted.startsWith('no')) return true;
	if (
		[
			'x-autoreply',
			'x-autorespond',
			'x-autoresponder',
			'x-autoreply-from',
			'x-mail-autoreply'
		].some((k) => h.has(k))
	)
		return true;
	if (/^(auto_reply|bulk|junk)$/.test(h.get('precedence') ?? h.get('x-precedence') ?? ''))
		return true;
	return /^(automatic reply|auto(matic)?[- ]?(reply|response)|out of (the )?office|自动回复)\s*[:：]/i.test(
		subject.trim()
	);
}
