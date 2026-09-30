// The one wire (§5.7, rules 32, 64–67): paths, headers, bodies and live frames shared by the host handler and `$bolt`.
// Pure data and two pure functions, so the browser bundle imports it without the engine.
import type { Json } from '../decl/values.ts';
import type { EngineActor, Outcome } from '../engine/contracts.ts';

export const BOLT = '/__bolt';
/** A workspace path under its public URL, which may carry a path (`https://host/acme`: one host serving many workspaces). */
export const under = (publicUrl: string, path: string): string => `${publicUrl.replace(/\/+$/, '')}${path}`;
/** The path a workspace is served under (`/acme`), `''` at the root; cookies and the service worker are scoped to it. */
export const basePath = (publicUrl: string): string => new URL(publicUrl).pathname.replace(/\/+$/, '');
/** The C8 wire table's data endpoints; hooks, the manifest and host ops are routed by their own owners. */
export const PATHS = {
	q: `${BOLT}/q`, act: `${BOLT}/act`, live: `${BOLT}/live`, files: `${BOLT}/files/`,
	session: { code: `${BOLT}/session/code`, verify: `${BOLT}/session/verify`, signout: `${BOLT}/session/signout`, invitation: `${BOLT}/session/invitation`,
		/** `GET`: how this workspace signs people in — by email, by mobile number — and whether newcomers may sign up. */
		methods: `${BOLT}/session/methods` },
	push: `${BOLT}/push`, openapi: `${BOLT}/openapi.json`, ops: `${BOLT}/ops`,
	/** The in-app agent panel: `GET ?conversation=` the transcript, `GET /models` the models the member may pick. Everything live rides `/live`. */
	agent: `${BOLT}/agent`,
	/**
	 * `GET ?id=` the approval view of one request (§3.8), for a participant or a reader of the held record; without `id`,
	 * the views the caller may see, filtered by `collection`, `record` and `request` (each repeated) and `all` (closed
	 * ones too).
	 */
	approval: `${BOLT}/approval`,
} as const;
/** The service worker web push needs (§5.7), served by the shell host with `Service-Worker-Allowed: /`. */
export const SW = `${BOLT}/sw.js`;
export const HEADERS = {
	key: 'Idempotency-Key', retry: 'Idempotency-Retry', contract: 'Bolt-Contract', challenge: 'Bolt-Challenge',
} as const;

/** One read as the guest names it (`ctx.db.read('c', q)` → `{ m: 'read', a: ['c', q] }`); `lowerRead` decodes both. */
/** `transcript` (`a: [conversation]`) and `conversations` (`a: []`, the member's own) are the agent panel's, live only: `/live` checks the caller may read them, `/q` refuses them. */
export type WireRead = { m: 'read' | 'get' | 'aggregate' | 'similar' | 'history' | 'query' | 'transcript' | 'inbox' | 'conversations'; a: readonly Json[] };
export type QBody = { reads: readonly WireRead[] };
export type QReply = { answers: readonly Json[] };
/**
 * `/act`: every write, action, `start` and approval decision; the key rides `Idempotency-Key` (rule 31). `start` takes
 * `{ automation, input, id }` (the client-minted uuidv7 run id); `approvals.process` `{ requestId, status, reason? }`;
 * `approvals.withdraw` `{ requestId }`. A decision's outcome is `committed` with output `{ requestId, status }`.
 * The in-app agent (§5.9): `sys_conversation.start` `{ title?, model? }` → output `{ id }`; `sys_message.post`
 * `{ conversation, text, mode? }` → `{ id }` (the turn runs after the reply); `sys_message.confirm` `{ message, approve }`;
 * `sys_conversation.setAgent` `{ conversation, agent }` (`'workspace'` or an envoy); `sys_message.file` `{ message, about }`
 * (`{ collection, id }` or `null`); `sys_message.markRead` `{ conversation }`; `sys_notification.markRead` `{ ids }` (the caller's own inbox
 * notices).
 */
export type ActBody = { callable: string; input: Json; issuedAt: string; observed?: { readonly [id: string]: number }; onConflict?: 'update' | 'keep' };
/** `v`: the lane sequence of the act's last commit (rule 66). */
export type ActReply = { outcome: Outcome; v: number };
export type WireError = { error: { code: string; message: string } };

/** A live registration: `every` (a `Duration`) re-answers a clock view; `on` re-runs a collection query (rule 64). */
export type LiveAdd = { view: string; read: WireRead; every?: string; on?: readonly string[] };
export type LiveBody = { conn: string; add?: readonly LiveAdd[]; drop?: readonly string[] };
export type LiveErrorCode = 'subscriptionTooLarge' | 'tooManySubscriptions' | 'cellBudget' | (string & {});
export type LiveReply = { errors: readonly { view: string; code: LiveErrorCode; message: string }[] };
/**
 * A change to a view's rows (rule 65): `upsert` drops the row with that id, if any, then inserts `row` at `index` of what
 * remains; `remove` drops it. On a `get` view the value is the row or `null`. A page's `next` is never patched.
 */
export type PatchOp = { op: 'upsert'; index: number; row: Json } | { op: 'remove'; id: string };
export type Frame =
	| { t: 'hello'; conn: string; v: number }
	/** The whole value: a view's first answer, and every fallback that re-read it. */
	| { t: 'answer'; view: string; v: number; value: Json }
	/** The ops that turn the view's value at its last frame into its value at `v`. */
	| { t: 'patch'; view: string; v: number; ops: readonly PatchOp[] }
	| { t: 'error'; view: string; code: LiveErrorCode; message: string }
	/** The lane advanced to `v`; everything before it is applied. */
	| { t: 'v'; v: number }
	/** A generation change (reset, restore, fork admit, release flip): reload, do not reconnect. */
	| { t: 'close'; release: string };

/** One transcript row as the agent panel shows it (hook:triage: `pending` awaits a decision, rule 60a); a held call (`state: 'confirm'`) carries the call it would make. */
export type AgentRow = { id: string; seq: number; role: 'user' | 'assistant' | 'tool' | 'system' | null; text: string | null;
	/** `streaming`: a reply still being written (its text grows patch by patch); `running`: a tool call still running. */
	state: 'pending' | 'queued' | 'consumed' | 'cancelled' | 'confirm' | 'streaming' | 'running' | null; /** when it was written */ at?: string; tag: string | null; call?: { name: string; input: Json }; receipts?: Json; /** hook:agent — the turn's summed model usage */ usage?: Json;
	/** hook:agent-ui — who wrote it, a failed turn's reason (staff only), what it is filed about */ author?: string | null; detail?: string; about?: Json;
	/** hook:attachments — the files a message carries (`id` when stored, for `fileUrl`) */ files?: { id?: string; name: string; mime: string }[];
	/** A tool step: which tool, and whether its result was an error (the panel folds a run of steps into one row); `child` a spawned sub-agent's conversation;
	 * `args` and `result` at most 600 characters each; `ms` how long it ran. */
	tool?: { name: string; failed: boolean; child?: string; running?: true; args?: string; result?: string; ms?: number };
	/** An assistant row's reasoning, verbatim (L-BOLT-548). */ reasoning?: string;
	/** A context checkpoint: the last seq it summarizes, the rows kept beside it, who asked for it (L-BOLT-546). */ compact?: { cutoff: number; keep: string[]; origin: 'manual' | 'requested' | 'automatic' } };
/** The live `conversations` read's row: one of the member's own in-app conversations or an envoy's channel thread (rule 61), most recently active first (`at`). */
export type AgentConversation = { id: string; title: string | null; at: string; status: 'idle' | 'running' | 'stopped'; model: string;
	plan: { revision: number; body: string; status: 'draft' | 'active' | 'verified'; /** the seq execution started after */ checkpoint?: number } | null; goals: { id: string; text: string; status: 'pending' | 'doing' | 'done' }[] | null;
	/** The envoy serving a channel thread, and the channel it is on; both null exactly when this is the member's own in-app conversation. */
	envoy: string | null; channel: string | null;
	/** A channel thread's kind (a direct message or a group chat) and its provider thread; null on an in-app conversation. */
	kind: 'dm' | 'group' | null; thread: string | null };
/** `POST /__bolt/push`: a browser `PushSubscription.toJSON()`, or `{ endpoint, remove: true }`. */
export type PushBody = { endpoint: string; keys?: { p256dh: string; auth: string }; remove?: true };

/** Rule 32: 200, 202, 400/403/404/422/429 and 409, 504. */
export function statusOf(o: Outcome): number {
	switch (o.kind) {
		case 'committed': return 200;
		case 'pendingApproval': return 202;
		case 'conflict': return 409;
		case 'unknown': return 504;
	}
	const c = o.code;
	return c === 'invalidInput' ? 400 : c === 'forbidden' || c === 'approvalHeld' || c === 'locked' ? 403 : c === 'notFound' ? 404 : c === 'rateLimited' ? 429 : 422;
}
/** Rule 32: public and API-key actors receive codes only (and the structured `field`, `row` and `data`). */
export function redact(o: Outcome, actor: EngineActor): Outcome {
	return o.kind === 'refused' && (actor.kind === 'envoy' || actor.kind === 'apiKey')
		? { kind: 'refused', code: o.code, message: o.code, ...(o.field === undefined ? {} : { field: o.field }), ...(o.row === undefined ? {} : { row: o.row }),
			...(o.data === undefined ? {} : { data: o.data }) }
		: o;
}

// ── rule 24: caller-minted ids ──
const DAY = 86_400_000;
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A caller-minted id is a uuidv7 whose timestamp is within 24 h of the host clock, either side. */
export function uuidv7Within(id: string, nowMs: number): boolean {
	return V7.test(id) && Math.abs(nowMs - parseInt(id.slice(0, 8) + id.slice(9, 13), 16)) <= DAY;
}
/** A fresh uuidv7 (RFC 9562): 48 bits of Unix milliseconds, version 7, variant 10, the rest random. */
export function uuidv7(nowMs: number = Date.now()): string {
	const b = crypto.getRandomValues(new Uint8Array(16));
	for (let i = 0; i < 6; i++) b[i] = Math.floor(nowMs / 2 ** (8 * (5 - i))) & 0xff;
	b[6] = (b[6]! & 0x0f) | 0x70; b[8] = (b[8]! & 0x3f) | 0x80;
	const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
