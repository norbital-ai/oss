// The shell's own reads and the settings verbs (§5.10, §5.11.1, §5.11.4, rules 46, 48): the inbox (open approval
// requests the viewer takes part in, and `inbox` notices addressed to them), `/runs`, and the admin settings over the
// identity tables. Every verb is an identity function (admin-only there); this file decodes and routes.
import type { Json } from '../decl/values.ts';
import type { Authority, EngineManifest, FilesPort, TenantDb } from '../engine/contracts.ts';
import type { AttachmentPort } from '../engine/agent/tools.ts';
import { xlsxCells, xlsxSheets } from '../engine/agent/xlsx.ts';
import { imageJob } from '../engine/runs/files.ts';
export type { Cell } from '../engine/agent/xlsx.ts';
import { canApprove, canSupersede, type Request } from '../engine/approvals/route.ts';
import * as members from '../engine/identity/members.ts';
import { refuse, requireAdmin, type IdentityHost, type Result } from '../engine/identity/session.ts';
import { actorRef } from '../engine/write/commit.ts';
import { RUN_VIEW_COLUMNS, runView, type RunView } from '../engine/runs/index.ts';
import { pausedIntegrations, setPaused } from '../engine/integrations/sync.ts';

type Row = { readonly [column: string]: Json };
const q = (text: string, ...params: Json[]) => ({ text, params });

/** §5.11.4's port as the shell uses it: names set or unset, never a value. */
export type SecretsPort = {
	status(owner: 'workspace' | string): Promise<{ readonly [name: string]: boolean }>;
	set(owner: 'workspace' | string, name: string, value: string): Promise<void>;
	clear(owner: 'workspace' | string, name: string): Promise<void>;
};

/** `by`: the requestor as a person reads them (their name, else email), `requestor` the actor reference. */
export type InboxRequest = { id: string; collection: string; record: string; action: string; step: number; steps: number; at: string;
	requestor: string; by: string; mine: boolean; canDecide: boolean; canSupersede: boolean };
export type Notice = { id: string; title: string; body: string | null; link: Json; at: string; read: boolean };
export type Inbox = { requests: InboxRequest[]; notices: Notice[] };
const INBOX_LIMIT = 200;

export async function inbox(db: TenantDb, auth: Authority): Promise<Inbox> {
	const a = auth.actor;
	if (a.kind !== 'member' || a.external) return { requests: [], notices: [] };
	const me = actorRef(a);
	const [open, notes] = await db.read([
		// ponytail: eligibility is filtered here over every open request; a step-team column indexes it when inboxes grow
		q(`SELECT a.id::text AS id, a.collection, a.record, a.action, a.requestor, a.step, a.route, a.state, a.at::text AS at,
			coalesce(u.name, u.email, a.requestor) AS by FROM bolt_approvals a LEFT JOIN sys_user u ON a.requestor = 'member:' || u.id
			WHERE a.state = 'Pending' ORDER BY a.at DESC LIMIT 2000`),
		// L-BOLT-354: an inbox notice is one row per member, fanned out when it was written; the member reads their own
		q(`SELECT id, title, body, link, at::text AS at, read_at IS NOT NULL AS read FROM sys_notification WHERE member = $1
			ORDER BY at DESC LIMIT ${INBOX_LIMIT}`, a.id),
	]);
	const requests: InboxRequest[] = [];
	for (const r of open!.rows) {
		const req = { state: 'Pending', step: Number(r['step']), requestor: String(r['requestor']), route: r['route'] as unknown as Request['route'] } satisfies Request;
		const view = { mine: req.requestor === me, canDecide: canApprove(req, a), canSupersede: canSupersede(req, auth) };
		if (!view.mine && !view.canDecide && !view.canSupersede) continue;
		requests.push({ id: String(r['id']), collection: String(r['collection']), record: String(r['record']), action: String(r['action']),
			step: req.step, steps: req.route.steps.length, at: String(r['at']), requestor: req.requestor, by: String(r['by']), ...view });
		if (requests.length === INBOX_LIMIT) break;
	}
	return { requests, notices: notes!.rows.map((n) => ({ id: String(n['id']), title: String(n['title']), body: n['body'] as string | null, link: n['link'] ?? null, at: String(n['at']), read: n['read'] === true })) };
}

export type RunRow = RunView;
/**
 * `/runs`: an administrator sees every run; a member (staff or external) the runs of automations they hold and the runs
 * they caused, each as rule 56 lets them read it (status, progress and the error code only for a run they merely caused).
 * `automation` narrows the list to one automation (`bolt.runs`, `RunsFor`).
 */
export async function runList(db: TenantDb, auth: Authority, limit = 100, automation?: string): Promise<RunRow[]> {
	const a = auth.actor;
	if (a.kind !== 'member') return [];
	const [rows] = await db.read([q(`SELECT ${RUN_VIEW_COLUMNS} FROM sys_run
		WHERE ($1 OR actor = $2 OR automation IN (SELECT jsonb_array_elements_text($3::jsonb))) AND ($4::text IS NULL OR automation = $4)
		ORDER BY due_at DESC LIMIT ${Math.min(Math.max(1, limit), 500)}`,
		auth.admin, actorRef(a), JSON.stringify(auth.automations), automation ?? null)]);
	return rows!.rows.flatMap((r) => runView(auth, r) ?? []);
}

export type ConversationRow = { id: string; envoy: string | null; channel: string; title: string | null; status: string;
	at: string | null; preview: string | null; author: string | null; unread: boolean };
/**
 * `/conversations` (§5.9 built-in reads, hook:agent-ui): staff browse every envoy (channel) conversation, newest message
 * first, each with its last message and whether it has any since the viewer's `markRead`.
 */
/** Envoy threads a member may see: one they posted in (group participant, DM sender) or a `public` envoy's (owner 2026-09-26). */
export async function conversationList(db: TenantDb, auth: Authority, publicEnvoys: readonly string[], limit = 200): Promise<ConversationRow[]> {
	const a = auth.actor;
	if (a.kind !== 'member' || a.external) return [];
	const [rows] = await db.read([q(`SELECT c.id, c.envoy, c.channel, c.title, c.status, l.at, l.preview, l.author,
			coalesce(l.seq > coalesce((c.read->>$1)::bigint, 0), false) AS unread
		FROM sys_conversation c LEFT JOIN LATERAL (SELECT m.seq, m.created_at::text AS at, m.preview, coalesce(m.author, m.sender_name, m.sender) AS author
			FROM sys_message m WHERE m.conversation = c.id AND m.deleted_at IS NULL ORDER BY m.seq DESC LIMIT 1) l ON true
		WHERE c.channel IS NOT NULL AND c.parent IS NULL AND (c.envoy IN (SELECT jsonb_array_elements_text($2::jsonb))
			OR EXISTS (SELECT 1 FROM sys_message p WHERE p.conversation = c.id AND $1 IN (p.author, p."as"->>'member', p."as"->'envoy'->>'member')))
		ORDER BY l.seq DESC NULLS LAST LIMIT ${Math.min(Math.max(1, limit), 500)}`, a.id, JSON.stringify(publicEnvoys))]);
	return rows!.rows as unknown as ConversationRow[];
}

export type Settings = {
	members: Row[]; teams: Row[]; assignments: Row[]; invitations: Row[]; keys: Row[];
	policies: string[]; secrets: { name: string; label: string; set: boolean | null }[];
	channels: { name: string; transport: Json; address: Json; delivery: ChannelDelivery }[]; connections: { name: string; auth: Json }[]; mcp: { name: string; url: Json }[];
	/** Identity changes (`bolt_history` of the identity tables), newest first (L-BOLT-518). */
	audit: { collection: string; record: string; revision: number; at: string; actor: string | null; op: string; changes: Json }[];
	/** `<collection>.integration`s; an administrator pauses or resumes each (L-BOLT-365). */
	integrations: { name: string; direction: Json; paused: boolean }[];
};

/**
 * A channel's outbound deliveries over the last day (L-BOLT-521): automatic retries are progress (`retrying`, with the
 * next attempt), only a settled failure is terminal; `lastError` is the newest failure's text.
 */
export type ChannelDelivery = { sent: number; pending: number; retrying: number; failed: number; nextRetry: string | null; lastError: string | null };
const AUDIT_LIMIT = 200;

/** The settings pages' rows (§5.11.1): one row per member with sessions collapsed to a last-seen time; admins only. */
export async function settings(h: IdentityHost, m: EngineManifest, auth: Authority, secrets?: SecretsPort): Promise<Result<Settings>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const [users, teams, assignments, invitations, keys, audit, deliveries] = await h.db.read([
		// administrators first, then staff, then external members; by name, else address (L-BOLT-516)
		q(`SELECT u.id, u.email, u.name, u.kind, u.active, u.admin, u.team, (SELECT max(s.refreshed_at)::text FROM sys_session s WHERE s."user" = u.id) AS last_seen
			FROM sys_user u ORDER BY u.admin DESC, u.kind = 'external', lower(coalesce(nullif(u.name, ''), u.email, '')), u.id`),
		q('SELECT id, name, parent FROM sys_team ORDER BY lower(name)'),
		q('SELECT id, principal_type, principal, policy, scope FROM sys_assignment ORDER BY policy, id'),
		q(`SELECT id, email, team, external, CASE WHEN accepted_at IS NOT NULL THEN 'accepted' WHEN revoked_at IS NOT NULL THEN 'revoked'
			WHEN expires_at <= $1::timestamptz THEN 'expired' ELSE 'open' END AS status, expires_at::text AS expires_at FROM sys_invitation ORDER BY expires_at DESC`, h.now().toISOString()),
		q('SELECT id, name, prefix, created_by, created_at::text AS created_at, revoked_at::text AS revoked_at, last_used_at::text AS last_used_at FROM sys_api_key ORDER BY name, id'),
		q(`SELECT collection, record::text AS record, revision, at::text AS at, actor, op, changes FROM bolt_history
			WHERE collection IN ('sys_user', 'sys_team', 'sys_assignment', 'sys_invitation') ORDER BY at DESC, revision DESC LIMIT ${AUDIT_LIMIT}`),
		q(`SELECT channel, count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status IN ('queued', 'sending') AND attempts = 0)::int AS pending,
			count(*) FILTER (WHERE status IN ('queued', 'sending') AND attempts > 0)::int AS retrying, count(*) FILTER (WHERE status IN ('failed', 'uncertain', 'skipped'))::int AS failed,
			min(next_attempt_at) FILTER (WHERE status = 'queued' AND attempts > 0)::text AS next_retry,
			(array_agg(error ORDER BY created_at DESC) FILTER (WHERE status IN ('failed', 'uncertain', 'skipped') AND error IS NOT NULL))[1] AS last_error
			FROM sys_message WHERE direction = 'outbound' AND created_at > $1::timestamptz - interval '1 day' GROUP BY channel`, h.now().toISOString()),
	]);
	const idle: ChannelDelivery = { sent: 0, pending: 0, retrying: 0, failed: 0, nextRetry: null, lastError: null };
	const delivery = new Map(deliveries!.rows.map((r) => [String(r['channel']), { sent: Number(r['sent']), pending: Number(r['pending']), retrying: Number(r['retrying']),
		failed: Number(r['failed']), nextRetry: (r['next_retry'] ?? null) as string | null, lastError: (r['last_error'] ?? null) as string | null }]));
	const env = Object.entries((m.workspace.env ?? {}) as { readonly [n: string]: { label: string; secret?: boolean } }).filter(([, d]) => d.secret !== false);
	const status = secrets === undefined ? null : await secrets.status('workspace');
	const paused = await pausedIntegrations(h.db);
	return { ok: true, value: {
		members: [...users!.rows], teams: [...teams!.rows], assignments: [...assignments!.rows], invitations: [...invitations!.rows], keys: [...keys!.rows],
		policies: Object.keys(m.policies),
		secrets: env.map(([name, d]) => ({ name, label: d.label, set: status === null ? null : status[name] === true })),
		channels: Object.entries(m.channels).map(([name, c]) => ({ name, transport: (c as Row)['transport'] ?? null, address: (c as Row)['address'] ?? null, delivery: delivery.get(name) ?? idle })),
		audit: audit!.rows as unknown as Settings['audit'],
		connections: Object.entries(m.connections).map(([name, c]) => ({ name, auth: (c as { auth?: Json }).auth ?? null })),
		mcp: Object.entries(m.mcp).map(([name, s]) => ({ name, url: (s as { url?: Json }).url ?? null })),
		integrations: Object.entries(m.integrations).map(([name, i]) => ({ name, direction: (i as Row)['direction'] ?? null, paused: paused.has(name) })),
	} };
}

export type LogLevel = 'info' | 'warn' | 'error';
export type LogRow = { id: string; at: string; severity: LogLevel; event: string; invocation: string; run: string | null; conversation: string | null;
	turn: string | null; attributes: Json };
export type LogQuery = { before?: string; after?: string; level?: LogLevel; text?: string };
const LOG_PAGE = 200;

/**
 * The workspace log (§5.12, admins only): one page of `sys_event`, newest first, keyed by its identity column. `before`
 * pages to older rows, `after` follows the tail; `level` and `text` (event name or attributes) narrow it.
 */
export async function events(db: TenantDb, auth: Authority, x: LogQuery): Promise<Result<LogRow[]>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const id = (v: string | undefined) => v !== undefined && /^\d{1,18}$/.test(v) ? v : null;
	const tail = id(x.after);
	const [rows] = await db.read([q(`SELECT id::text AS id, at::text AS at, severity, event, invocation, run, conversation, turn, attributes FROM sys_event
		WHERE ($1::bigint IS NULL OR id < $1::bigint) AND ($2::bigint IS NULL OR id > $2::bigint) AND ($3::text IS NULL OR severity = $3)
			AND ($4::text IS NULL OR strpos(lower(event), lower($4)) > 0 OR strpos(lower(attributes::text), lower($4)) > 0)
		ORDER BY sys_event.id ${tail === null ? 'DESC' : 'ASC'} LIMIT ${LOG_PAGE}`, id(x.before), tail, x.level ?? null, x.text === undefined || x.text === '' ? null : x.text)]);
	// the tail reads forward from `after` so a burst larger than a page leaves no gap; the answer is newest first either way
	const out = rows!.rows as unknown as LogRow[];
	return { ok: true, value: tail === null ? out : [...out].reverse() };
}

const str = (v: Json | undefined): v is string => typeof v === 'string' && v !== '';
const strOrNull = (v: Json | undefined): v is string | null => v === null || str(v);
const ref = (v: Json | undefined): v is { collection: string; id: string } =>
	typeof v === 'object' && v !== null && !Array.isArray(v) && str((v as Row)['collection']) && str((v as Row)['id']);
const bad = (op: string) => refuse('check', `The input of '${op}' is malformed.`);

/** One settings verb. Inputs come from the browser, so each is checked before it reaches identity. */
export async function settingsOp(h: IdentityHost, m: EngineManifest, auth: Authority, op: string, x: Row, secrets?: SecretsPort): Promise<Result<Json>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const id = x['id'];
	switch (op) {
		case 'invite': {
			if (!str(x['email']) || !(x['team'] === undefined || str(x['team']))) return bad(op);
			const assignments = Array.isArray(x['assignments']) ? x['assignments'] : [];
			if (!assignments.every((a) => typeof a === 'object' && a !== null && !Array.isArray(a) && str((a as Row)['policy']) && ((a as Row)['scope'] === undefined || ref((a as Row)['scope'])))) return bad(op);
			if (!(x['party'] === undefined || ref(x['party']))) return bad(op);
			return members.invite(h, m, auth, { email: x['email'], ...(str(x['team']) ? { team: x['team'] } : {}), external: x['external'] === true,
				assignments: assignments as members.InviteInput['assignments'] & object, ...(ref(x['party']) ? { party: x['party'] } : {}) });
		}
		case 'revokeInvitation': return str(id) ? members.revokeInvitation(h, auth, id) : bad(op);
		case 'resendInvitation': return str(id) ? members.resendInvitation(h, auth, id) : bad(op);
		case 'setAdmin': return str(id) && typeof x['admin'] === 'boolean' ? members.setAdmin(h, auth, id, x['admin']) : bad(op);
		case 'deactivate': return str(id) ? members.deactivate(h, auth, id) : bad(op);
		case 'reactivate': return str(id) ? members.reactivate(h, auth, id) : bad(op);
		case 'assignTeam': return str(id) && strOrNull(x['team']) ? members.assignTeam(h, auth, id, x['team']) : bad(op);
		case 'createTeam': return str(x['name']) && strOrNull(x['parent'] ?? null) ? members.createTeam(h, auth, x['name'], (x['parent'] ?? null) as string | null) : bad(op);
		case 'moveTeam': return str(id) && strOrNull(x['parent']) ? members.moveTeam(h, auth, id, x['parent']) : bad(op);
		case 'renameTeam': return str(id) && str(x['name']) ? members.renameTeam(h, auth, id, x['name'].trim()) : bad(op);
		case 'deleteTeam': return str(id) ? members.deleteTeam(h, auth, id) : bad(op);
		case 'assign': {
			const type = x['type'];
			if (type !== 'sys_user' && type !== 'sys_team' && type !== 'sys_api_key') return bad(op);
			if (!str(x['principal']) || !str(x['policy']) || !(x['scope'] === undefined || ref(x['scope']))) return bad(op);
			return members.assign(h, m, auth, { type, id: x['principal'] }, x['policy'], ref(x['scope']) ? x['scope'] : undefined);
		}
		case 'unassign': return str(id) ? members.unassign(h, auth, id) : bad(op);
		case 'issueKey': return str(x['name']) ? members.issueKey(h, auth, x['name']) : bad(op);
		case 'rotateKey': return str(id) ? members.rotateKey(h, auth, id) : bad(op);
		case 'revokeKey': return str(id) ? members.revokeKey(h, auth, id) : bad(op);
		case 'pauseIntegration': case 'resumeIntegration': {
			if (!str(x['name']) || m.integrations[x['name']] === undefined) return refuse('notFound', `'${String(x['name'])}' has no integration.`);
			await setPaused(h.db, x['name'], op === 'pauseIntegration');
			return { ok: true, value: null };
		}
		case 'setSecret': case 'clearSecret': {
			if (secrets === undefined) return refuse('unavailable', 'This host stores no secrets.');
			const name = x['name'], decl = (m.workspace.env ?? {}) as { readonly [n: string]: { secret?: boolean } };
			// an undeclared or non-secret name is refused on write (§5.11.4)
			if (!str(name) || decl[name] === undefined || decl[name].secret === false) return refuse('notFound', `'${String(name)}' is no declared secret.`);
			if (op === 'clearSecret') await secrets.clear('workspace', name);
			else if (str(x['value'])) await secrets.set('workspace', name, x['value']);
			else return bad(op);
			return { ok: true, value: null };
		}
	}
	return refuse('notFound', `There is no settings verb '${op}'.`);
}

// The agent's `read_attachment` for any host with a files port: a message's stored file as text, an image, or a sheet.
// An xlsx sheet is read into std/sheet's `Cell[][]` (its first worksheet, header row first); other sheets as CSV text.
const TEXT = /^(text\/|application\/(json|xml|csv))/;
/** The image types model providers take as they are. */
const MODEL_IMAGE = /^image\/(jpeg|png|webp|gif)$/;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** A sheet's rows the agent sees at most; the rest is reported, not read. */
export const SHEET_ROWS = 2_000;
export function fileAttachments(db: TenantDb, files: FilesPort): AttachmentPort {
	return {
		async read(file, as, signal, sheet = 0) {
			const ref = (file as { file?: Json } | null)?.file ?? file; // hook:attachments — an envoy's descriptor carries its FileRef in `file`
			const id = String((ref as { id?: Json } | null)?.id ?? '');
			const [r] = await db.read([{ text: `SELECT key, mime FROM sys_file WHERE id = $1`, params: [id] }]);
			const row = r!.rows[0];
			if (row === undefined) throw new Error('the file is not stored');
			const mime = String(row['mime']), bytes = await files.get(String(row['key']), 20 * 1024 * 1024, signal);
			const name = String((ref as { name?: Json }).name ?? '');
			if (as === 'image') {
				if (!mime.startsWith('image/')) throw new Error(`a ${mime} file is not an image`);
				// a phone's HEIC is no type a model reads: it goes as a derived JPEG (a raw one stalled the turn)
				return MODEL_IMAGE.test(mime) ? { mime, bytes } : { mime: 'image/jpeg', bytes: await imageJob(bytes, 2048, signal) as Uint8Array };
			}
			if (as === 'document') { if (mime !== 'application/pdf') throw new Error(`a ${mime} file is not a PDF`); return { mime, bytes }; }
			if (mime === XLSX || name.toLowerCase().endsWith('.xlsx')) { // hook:agent-ui
				const sheets = xlsxSheets(bytes), cells = xlsxCells(bytes, sheet);
				return { name, mime, sheets, sheet: sheets[sheet]!, rows: cells.length, cells: cells.slice(0, SHEET_ROWS),
					...(cells.length > SHEET_ROWS ? { truncated: `only the first ${SHEET_ROWS} rows are shown` } : {}) };
			}
			if (!TEXT.test(mime)) throw new Error(`a ${mime} file cannot be read as ${as} here`);
			return { name, mime, text: new TextDecoder().decode(bytes).slice(0, 64 * 1024) };
		},
	};
}

