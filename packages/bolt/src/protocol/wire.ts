// The one wire (§5.7, rules 32, 64–67): paths, headers, bodies and live frames shared by the host handler and `$bolt`.
// Pure data and pure functions; the bodies' types are their Schemas' (`schema.ts`).
import type { ActOutcome, EngineActor } from '../engine/contracts.ts';
import { BoltError, CODE } from './errors.ts';
import type { WireError } from './schema.ts';

export const BOLT = '/__bolt';
/** The integrations a member may connect (a canonical path keeps no trailing slash). */
export const INTEGRATION_LIST = `${BOLT}/integrations`;
/** An integration instance's management routes; its `test` verb may invoke an authored guest body. */
export const INTEGRATIONS = `${INTEGRATION_LIST}/`;
/** A workspace path under its public URL, which may carry a path (`https://host/acme`: one host serving many workspaces). */
export const under = (publicUrl: string, path: string): string =>
	`${publicUrl.replace(/\/+$/, '')}${path}`;
/** The path a workspace is served under (`/acme`), `''` at the root; cookies and the service worker are scoped to it. */
export const basePath = (publicUrl: string): string =>
	new URL(publicUrl).pathname.replace(/\/+$/, '');
/**
 * The one spelling of a workspace path (`docs/hosts.md`, URL scheme): repeated slashes collapse and a trailing slash
 * goes, the root `/` aside. A host answers any other spelling with one 308 to this one.
 */
export const canonicalPath = (path: string): string =>
	path.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
/** The C8 wire table's data endpoints; hooks, the manifest and host ops are routed by their own owners. */
export const PATHS = {
	q: `${BOLT}/q`,
	act: `${BOLT}/act`,
	live: `${BOLT}/live`,
	files: `${BOLT}/files/`,
	session: {
		code: `${BOLT}/session/code`,
		verify: `${BOLT}/session/verify`,
		signout: `${BOLT}/session/signout`,
		invitation: `${BOLT}/session/invitation`,
		/** `GET`: how this workspace signs people in — by email, by mobile number — and whether newcomers may sign up. */
		methods: `${BOLT}/session/methods`
	},
	push: `${BOLT}/push`,
	/**
	 * `GET`: the signed-in member's notices created after the stream opened, each `{ id, title, body, path }` as an
	 * event whose `id` is its `at`; `Last-Event-ID` (or `?since=`) also replays the unread ones after that instant.
	 */
	notices: `${BOLT}/notices`,
	openapi: `${BOLT}/openapi.json`,
	ops: `${BOLT}/ops`,
	/** The in-app agent panel: `GET ?conversation=` the transcript, `GET /models` the models the member may pick. Everything live rides `/live`. */
	agent: `${BOLT}/agent`,
	/**
	 * `GET ?id=` the approval view of one request, for a participant or an authorized reader of its referenced record; without `id`,
	 * the views the caller may see, filtered by `model`, `record` and `request` (each repeated) and `all` (closed
	 * ones too).
	 */
	approval: `${BOLT}/approval`,
	recordCapabilities: `${BOLT}/record-capabilities`
} as const;
/** The workspace path a notice opens: its linked record over the inbox, or the inbox. */
export const noticePath = (link: { readonly model: string; readonly id: string } | null): string =>
	link === null
		? '/inbox'
		: `/inbox?record=${encodeURIComponent(link.model)}/${encodeURIComponent(link.id)}`;
/** The service worker web push needs (§5.7), served by the shell host with `Service-Worker-Allowed: /`. */
export const SW = `${BOLT}/sw.js`;
export const HEADERS = {
	key: 'Idempotency-Key',
	retry: 'Idempotency-Retry',
	contract: 'Bolt-Contract',
	challenge: 'Bolt-Challenge',
	/** A kiosk page's requests name their kiosk; the host runs them as its assigned policies (never the caller's). */
	kiosk: 'Bolt-Kiosk'
} as const;

export type {
	ActBody,
	ActReply,
	AgentConversation,
	AgentRow,
	Frame,
	LiveAdd,
	LiveBody,
	LiveErrorCode,
	LiveReply,
	PatchOp,
	PushBody,
	QBody,
	QReply,
	WireError,
	WireRead
} from './schema.ts';

/** Rule 32: an outcome's status (200, 202, 409, 504, a refusal 400/403/404/429 or 422); 202 is two kinds, told apart by `kind`. */
const OUTCOME_STATUS: { readonly [K in Exclude<ActOutcome['kind'], 'refused'>]: number } = {
	committed: 200,
	pendingApproval: 202,
	running: 202,
	conflict: 409,
	unknown: 504
};
const REFUSED_STATUS: {
	readonly [C in Extract<ActOutcome, { kind: 'refused' }>['code']]?: number;
} = {
	invalidInput: 400,
	forbidden: 403,
	locked: 403,
	notFound: 404,
	rateLimited: 429
};
/** Every `rateLimited` refusal's one message; the shell translates it (shell/i18n.ts). */
export const RATE_LIMITED = 'Too many requests. Wait a moment and try again.';
export const statusOf = (o: ActOutcome): number =>
	o.kind === 'refused' ? (REFUSED_STATUS[o.code] ?? 422) : OUTCOME_STATUS[o.kind];
/** The client's reading of a transport failure's status (`statusOf` reversed): the refusal it stands for, else `null` (the outcome is unknown). */
const STATUS_REFUSAL: {
	readonly [status: number]: 'invalidInput' | 'forbidden' | 'notFound' | 'rateLimited';
} = {
	400: 'invalidInput',
	401: 'forbidden',
	403: 'forbidden',
	404: 'notFound',
	429: 'rateLimited'
};
export const refusalOfStatus = (
	status: number
): 'invalidInput' | 'forbidden' | 'notFound' | 'rateLimited' | null =>
	STATUS_REFUSAL[status] ?? null;
/** A transport failure as it is answered: a `BoltError` by its code at `CODE`'s status, anything else a 500 that names nothing. */
export const wireError = (e: unknown): { status: number; body: WireError } =>
	e instanceof BoltError
		? { status: CODE[e.code].status, body: { error: { code: e.code, message: e.message } } }
		: { status: 500, body: { error: { code: 'internal', message: 'The request failed.' } } };
/** Rule 32: public and API-key actors receive codes only (and the structured `field`, `row` and `data`). */
export function redact(o: ActOutcome, actor: EngineActor): ActOutcome {
	return o.kind === 'refused' && (actor.kind === 'envoy' || actor.kind === 'apiKey')
		? {
				kind: 'refused',
				code: o.code,
				message: o.code,
				...(o.field === undefined ? {} : { field: o.field }),
				...(o.row === undefined ? {} : { row: o.row }),
				...(o.data === undefined ? {} : { data: o.data })
			}
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
	b[6] = (b[6]! & 0x0f) | 0x70;
	b[8] = (b[8]! & 0x3f) | 0x80;
	const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
