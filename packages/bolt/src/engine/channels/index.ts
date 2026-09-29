// Channels (rule 61, §3.3.8, §5.9, P24): the gateway for envoys, integrations and notifications. Inbound is durable
// before the provider is acknowledged and deduplicated by `(channel, provider_id)`; edits converge a row, revokes
// tombstone it. Outbound is at least once, serially per conversation in `seq` order, with outcome `sent | failed |
// uncertain`; delivery events and email replies are mapped back onto the causing row by an act as the channel's actor,
// which per-state `edit` never refuses (rule 41). Staff never speak into a thread here: replies come only from the channel (rule 61).
import type { Json } from '../../decl/values.ts';
import { catalogOf } from '../access/pred.ts';
import type { Authority, Bindings, DeadlinesPort, EngineActor, FilesPort, GuestPort, Outcome, TransportEvent, TransportPort } from '../contracts.ts';
import { BoltError, callPort, LIMITS } from '../contracts.ts';
import type { Engine } from '../index.ts';
import { mappingBody } from '../integrations/runner.ts';
import * as ir from '../../protocol/ir.ts';
import { Chain } from '../write/sql.ts';
import { checkOutbound, DELIVER, prepareSend, sendPiece, threadOf } from './outbound.ts';
import { conversationId, isObj, messageId, NOTIFY, preview, sql, stableId, type Obj } from './store.ts';
import { decodeInbound, type Inbound } from './transports.ts';

export type Transports = { readonly email?: TransportPort; readonly whatsapp?: TransportPort; readonly telegram?: TransportPort; readonly push?: TransportPort };
export type ChannelsConfig = {
	engine: Pick<Engine, 'manifest' | 'db' | 'act' | 'read' | 'authority'>;
	transports?: Transports; files?: FilesPort; guest?: GuestPort;
	/** Delivery retries wake the scope at their due time (rule 52a). */
	deadlines?: DeadlinesPort; scope?: string;
	clock?: () => string;
	/** The environment epoch (rule 61): rows of another epoch — a fork's, a restore's — are never sent. */
	epoch?: string;
	/** Rows the ingest newly wrote, once durable: the envoys area admits them. */
	admit?: (row: Ingested) => Promise<void>;
	/** Channel-sourced integrations (`engine.integrations.deliver`). */
	integrations?: { deliver(event: TransportEvent, run: string): Promise<unknown> };
};
/** One inbound row as the ingest wrote it. */
export type Ingested = Inbound & { row: string; channel: string; conversation: string; inserted: boolean; files: readonly Json[] };
export type DeliveryKind = 'sent' | 'delivered' | 'opened' | 'bounced' | 'failed' | 'replied';
const KINDS = new Set(['sent', 'delivered', 'opened', 'bounced', 'failed', 'replied']);
const MAX_ATTEMPTS = 8;
/** An admitted row (`role` set) keeps its transcript content; only unadmitted history is rewritten by an edit or a revoke. */
const KEEP = (col: string) => `CASE WHEN sys_message.role IS NULL THEN excluded.${col} ELSE sys_message.${col} END`;
const TOMBSTONE = `text = CASE WHEN sys_message.role IS NULL THEN '' ELSE sys_message.text END, preview = CASE WHEN sys_message.role IS NULL THEN '' ELSE sys_message.preview END,
	files = CASE WHEN sys_message.role IS NULL THEN '[]'::jsonb ELSE sys_message.files END, email = CASE WHEN sys_message.role IS NULL THEN NULL ELSE sys_message.email END`;
const LEASE = `interval '10 minutes'`;

export function channels(cfg: ChannelsConfig) {
	const { manifest: m, db } = cfg.engine;
	const clock = cfg.clock ?? (() => new Date().toISOString());
	const epoch = cfg.epoch ?? '';
	const cat = catalogOf(m);
	const bindings = (): Bindings => { const now = clock(); return { now, today: now.slice(0, 10), tz: m.workspace.tz, params: {} }; };
	const specOf = (channel: string): Obj => {
		const s = m.channels[channel];
		if (s === undefined) throw new BoltError('unknownChannel', 'decode', `no channel '${channel}'`);
		return s as Obj;
	};
	const transportOf = (channel: string): string => String(specOf(channel)['transport']);
	/** The channel's own actor: exactly its declared `policies` (today's `channelSubject`). */
	const actorOf = (channel: string): Authority => {
		const actor: EngineActor = { kind: 'system', run: `channel:${channel}`, by: { platform: `channels.${channel}` } };
		return cfg.engine.authority({ actor, admin: false, policies: (specOf(channel)['policies'] as readonly string[] | undefined) ?? [] }, `channel:${channel}`);
	};
	const body = (channel: string) => mappingBody({ engine: cfg.engine, ...(cfg.guest === undefined ? {} : { guest: cfg.guest }) }, actorOf(channel), bindings(), `channel:${channel}`);

	// ── inbound ──
	/** Stores the attachment bytes (files port, `sys_file` rows in the message's own statement); descriptors without bytes stay named. */
	async function files(inbound: Inbound, bins: readonly Uint8Array[] | undefined, c: Chain, now: string): Promise<Json[]> {
		const out: Json[] = [];
		for (const [i, a] of inbound.attachments.entries()) {
			const bytes = a.bin === undefined ? undefined : bins?.[a.bin];
			if (a.file !== undefined || bytes === undefined) { out.push({ fileName: a.fileName, mimeType: a.mimeType, byteLength: a.byteLength, file: a.file ?? null }); continue; }
			if (bytes.byteLength !== a.byteLength) throw new BoltError('invalidInput', 'decode', `attachment ${a.fileName} does not match its declared length`);
			const blob = await callPort('files', cfg.files, LIMITS.callMs.other, (p, signal) => p.put(bytes, { name: a.fileName, mime: a.mimeType }, signal));
			if ('kind' in blob) throw new BoltError('files', 'facility', 'message' in blob ? blob.message : blob.reason);
			const id = messageId('file', `${inbound.id}:${i}`);
			c.cte(`f${i}`, `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at) VALUES (${c.p(id)}, ${c.p(a.fileName)}, ${c.p(a.mimeType)},
				${c.p(bytes.byteLength)}, ${c.p(blob.key)}, ${c.p(blob.sha256)}, 'sys_message.files', ${c.p(now)}::timestamptz) ON CONFLICT (id) DO NOTHING RETURNING id`);
			out.push({ fileName: a.fileName, mimeType: a.mimeType, byteLength: a.byteLength, file: { id, name: a.fileName, mime: a.mimeType } });
		}
		return out;
	}

	/** One inbound message in one statement: its conversation, then the row (a newer version converges it, a revoke tombstones it). */
	async function ingest(channel: string, message: Json, bins?: readonly Uint8Array[]): Promise<Ingested | null> {
		const inbound = decodeInbound(transportOf(channel), message);
		if (inbound === null) throw new BoltError('invalidInput', 'decode', `the ${channel} adapter delivered a malformed message`);
		const now = clock(), c = new Chain();
		const conv = conversationId(channel, inbound.thread), id = messageId(channel, inbound.id);
		if (inbound.deleted && inbound.thread === '') { // a bare revoke: tombstone the row, or hold the id so the message never lands
			await db.write(sql(`WITH upd AS (UPDATE sys_message SET deleted_at = $3::timestamptz, ${TOMBSTONE} WHERE id = $1 AND deleted_at IS NULL RETURNING id)
				INSERT INTO sys_message (id, channel, direction, origin, provider_id, text, preview, deleted_at, created_at)
				SELECT $1, $2, 'inbound', 'live', $4, '', '', $3::timestamptz, $3::timestamptz WHERE NOT EXISTS (SELECT 1 FROM sys_message WHERE id = $1)
				ON CONFLICT (id) DO NOTHING`, id, channel, now, inbound.id));
			return null;
		}
		const stored = inbound.deleted ? [] : await files(inbound, bins, c, now);
		const envoy = Object.entries(m.envoys).find(([, e]) => e['channel'] === channel)?.[0] ?? null;
		// a group's name follows the provider's latest (a renamed group), never erased by a message that does not carry it
		c.cte('conv', `INSERT INTO sys_conversation (id, channel, thread, kind, envoy, title) VALUES (${c.p(conv)}, ${c.p(channel)}, ${c.p(inbound.thread)},
			${c.p(inbound.group ? 'group' : 'dm')}, ${c.p(envoy)}, ${c.p(inbound.title)}) ON CONFLICT (id) DO UPDATE SET title = excluded.title
			WHERE excluded.title IS NOT NULL AND sys_conversation.title IS DISTINCT FROM excluded.title RETURNING id`);
		const text = inbound.deleted ? '' : inbound.text;
		c.cte('msg', `INSERT INTO sys_message (id, conversation, channel, direction, origin, provider_id, version, sender, sender_name, sent_at, invocation,
			preview, text, email, files, reply_to, deleted_at, created_at)
		VALUES (${c.p(id)}, ${c.p(conv)}, ${c.p(channel)}, 'inbound', ${c.p(inbound.history ? 'sync' : 'live')}, ${c.p(inbound.id)}, ${c.p(inbound.version)},
			${c.p(inbound.sender)}, ${c.p(inbound.senderName)}, ${c.p(inbound.sentAt)}::timestamptz, ${c.p(inbound.invocation)}, ${c.p(preview(text))}, ${c.p(text)},
			${c.p(inbound.email)}::jsonb, ${c.p(stored)}::jsonb, ${c.p(inbound.replyTo)}, ${inbound.deleted ? `${c.p(now)}::timestamptz` : 'NULL'},
			${c.p(now)}::timestamptz)
		ON CONFLICT (id) DO UPDATE SET ${inbound.deleted
			? `deleted_at = excluded.deleted_at, ${TOMBSTONE} WHERE sys_message.deleted_at IS NULL`
			// an admitted row is the agent's transcript: an edit never rewrites what the model already saw
			: `text = ${KEEP('text')}, preview = ${KEEP('preview')}, email = ${KEEP('email')}, files = ${KEEP('files')}, version = excluded.version,
				sender_name = coalesce(excluded.sender_name, sys_message.sender_name), edited_at = ${c.p(now)}::timestamptz
			WHERE sys_message.deleted_at IS NULL AND excluded.version > sys_message.version`}
		RETURNING (xmax = 0) AS inserted`);
		const [row] = (await db.write(c.sql(`(SELECT inserted FROM msg) AS inserted, (SELECT count(*) FROM msg)::int AS n`))).rows;
		if (row!['n'] === 0) return null; // a redelivery, an older version, or a change to a tombstone: nothing moved
		return { ...inbound, row: id, channel, conversation: conv, inserted: row!['inserted'] === true, files: stored };
	}

	/** Every transport event: inbound rows, then who reads them (envoys, integrations, email reply mapping); delivery events. */
	async function receive(event: TransportEvent): Promise<void> {
		if (event.kind === 'delivery') {
			if (KINDS.has(event.event)) await delivered(event.channel, event.providerId, event.event as DeliveryKind, event.at, event.data ?? null);
			return;
		}
		const got = await ingest(event.channel, event.message, event.bins);
		if (got === null || !got.inserted || got.deleted) return;
		if (!got.history) await cfg.integrations?.deliver(event, `channel:${event.channel}:${got.row}`);
		if (got.email !== null && got.references.length > 0) await replied(got);
		if (!got.history) await cfg.admit?.(got);
	}

	// ── delivery events → the causing row ──
	async function delivered(channel: string, providerId: string, kind: DeliveryKind, at: string, data: Json): Promise<Outcome | null> {
		const reason = isObj(data) && typeof data['reason'] === 'string' ? data['reason'] : null;
		const res = await db.write(sql(`UPDATE sys_message SET delivery = delivery || jsonb_build_object($3::text, $4::text),
			status = CASE WHEN $3 IN ('bounced', 'failed') THEN 'failed' ELSE status END, error = coalesce($5, error)
			WHERE channel = $1 AND provider_id = $2 AND direction = 'outbound' RETURNING id, record`, channel, providerId, kind, at, reason));
		const row = res.rows[0];
		if (row === undefined) return null;
		return patch(channel, row['record'] as Obj | null, kind, { at, message: row['id']!, ...(reason === null ? {} : { reason }) });
	}
	/** An email reply is matched to its sending row by the outbound message's provider id or `thread` (rule 61). */
	async function replied(mail: Ingested): Promise<void> {
		const refs = [...mail.references, mail.thread];
		const [res] = await db.read([sql(`SELECT id, record FROM sys_message WHERE channel = $1 AND direction = 'outbound'
			AND (provider_id IN (SELECT jsonb_array_elements_text($2::jsonb)) OR thread IN (SELECT jsonb_array_elements_text($2::jsonb))) ORDER BY seq DESC LIMIT 1`,
		mail.channel, refs)]);
		const row = res!.rows[0];
		if (row === undefined) return;
		await db.write(sql(`UPDATE sys_message SET delivery = delivery || jsonb_build_object('replied', $2::text) WHERE id = $1`, row['id']!, mail.sentAt));
		await patch(mail.channel, row['record'] as Obj | null, 'replied', { at: mail.sentAt, message: row['id']!, mail: mail.email });
	}
	/**
	 * `events.<kind>(e) → Patch`, applied as the channel's actor through the collection's pipeline. Per-state `edit` never
	 * refuses it (rule 41); a concurrent event on the same row is written again on a fresh read (a patch only sets values).
	 * ponytail: the manifest drops bodies, so an undeclared kind costs one isolate that answers `missingBody`.
	 */
	async function patch(channel: string, record: Obj | null, kind: DeliveryKind, event: Obj): Promise<Outcome | null> {
		if (record === null || typeof record['collection'] !== 'string' || typeof record['id'] !== 'string' || cfg.guest === undefined) return null;
		let set: Json;
		try {
			set = await body(channel)(`channel.${channel}.events.${kind}`, [event]);
		} catch (e) {
			if (e instanceof BoltError && e.code === 'missingBody') return null;
			return { kind: 'refused', code: 'invalidInput', message: `the ${kind} mapping failed: ${(e as Error).message}` };
		}
		if (!isObj(set) || Object.keys(set).length === 0) return null;
		const b = bindings(), authority = actorOf(channel);
		let outcome: Outcome | null = null;
		for (let attempt = 0; attempt < 5; attempt++) {
			const key = `channel:${channel}:${String(event['message'])}:${kind}:${attempt}`;
			outcome = (await cfg.engine.act({ collection: record['collection'], verb: 'update', input: { target: record['id'], set }, key, issuedAt: b.now,
				authority, bindings: b, invocationId: key, delivery: true })).outcome; // hook:envoys — `delivery`: rule 41's exception
			if (outcome.kind !== 'conflict') break;
		}
		return outcome;
	}

	// ── outbound ──
	/** `ctx.send`, an envoy reply, a notice: one queued row, committed, then delivered at once (best effort). */
	async function send(channel: string, message: Json, options: { kind?: 'dm' | 'group'; id?: string } = {}): Promise<string> {
		const prepared = await prepareSend(m, db, channel, message);
		if ('error' in prepared) throw new BoltError('invalidInput', 'decode', prepared.error);
		const now = clock(), c = new Chain(), id = options.id ?? crypto.randomUUID();
		sendPiece(c, { ...prepared, id, ...(options.kind === undefined ? {} : { kind: options.kind }) }, now);
		await db.write(c.sql('(SELECT count(*) FROM sent)::int AS n'));
		cfg.deadlines?.announce(cfg.scope ?? '', now);
		await deliver().catch(() => undefined);
		return id;
	}

	/** Builds a record-driven row's message from the row as committed; `false` when it settled without one. */
	async function build(r: Obj): Promise<boolean> {
		const channel = String(r['channel']), record = r['record'] as Obj;
		const fail = async (status: 'failed' | 'skipped', error: string) => {
			await db.write(sql(`UPDATE sys_message SET status = $2, error = $3 WHERE id = $1 AND status = 'queued'`, r['id']!, status, error.slice(0, 2000)));
			if (status === 'failed') await patch(channel, record, 'failed', { at: clock(), message: r['id']!, reason: error.slice(0, 500) });
			return false;
		};
		const [row] = await cfg.engine.read([ir.get(cat, String(record['collection']), String(record['id']))], { as: 'workspace' }, bindings()).catch(() => [null]);
		if (row === null || row === undefined) return fail('skipped', 'the record no longer exists');
		let built: Json;
		try {
			built = await body(channel)(`channel.${channel}.outbound.${String(r['rule'])}.message`, [{ record: row }]);
		} catch (e) {
			return fail('failed', `the ${String(r['rule'])} message failed: ${(e as Error).message}`);
		}
		const checked = checkOutbound(transportOf(channel), built);
		if ('error' in checked) return fail('failed', `the message does not fit ${transportOf(channel)}: ${checked.error}`);
		const thread = await threadOf(m, db, channel, checked.message, String(record['id']));
		const conv = conversationId(channel, thread);
		const text = typeof checked.message['text'] === 'string' ? checked.message['text'] : String(checked.message['subject'] ?? '');
		await db.write(sql(`WITH conv AS (INSERT INTO sys_conversation (id, channel, thread, kind) VALUES ($2, $3, $4, 'dm') ON CONFLICT (id) DO NOTHING RETURNING id)
			UPDATE sys_message SET message = $5::jsonb, conversation = $2, thread = $6, text = $7, preview = $8 WHERE id = $1 AND status = 'queued'`,
		r['id']!, conv, channel, thread, JSON.stringify(checked.message), typeof checked.message['thread'] === 'string' ? checked.message['thread'] : null, text, preview(text)));
		return true;
	}

	/** One send attempt of a claimed head row, settled on the row. */
	async function attempt(r: Obj): Promise<'sent' | 'retry' | 'failed' | 'uncertain'> {
		const channel = String(r['channel']), transport = transportOf(channel), now = clock();
		const message = r['message'] as Obj;
		const [refs] = await db.read([sql(`SELECT provider_id FROM sys_message WHERE conversation = $1 AND provider_id IS NOT NULL AND id <> $2 ORDER BY seq DESC LIMIT 50`,
			r['conversation']!, r['id']!)]);
		const references = refs!.rows.map((x) => String(x['provider_id'])).reverse();
		const address = specOf(channel)['address'];
		const wire: Obj = { ...message, id: String(r['id']), ...(transport === 'email' ? {} : { to: String(r['conv_thread']) }),
			...(typeof address === 'string' ? { from: address } : {}), ...(references.length === 0 ? {} : { inReplyTo: references.at(-1)!, references }) };
		const got = await callPort('transport', (cfg.transports as { [t: string]: TransportPort } | undefined)?.[transport], LIMITS.callMs.http,
			(p, signal) => p.send(channel, wire, signal), (x): x is { providerId: string } => isObj(x) && typeof x['providerId'] === 'string' && x['providerId'] !== '');
		const attempts = Number(r['attempts']);
		if (!('kind' in got)) {
			await db.write(sql(`UPDATE sys_message SET status = 'sent', provider_id = $2, sent_at = $3::timestamptz, error = NULL,
				delivery = delivery || jsonb_build_object('sent', $3::text) WHERE id = $1`, r['id']!, got.providerId, now));
			if (r['record'] !== null) await patch(channel, r['record'] as Obj, 'sent', { at: now, message: r['id']! });
			return 'sent';
		}
		const error = 'message' in got ? got.message : got.reason;
		const final = got.kind === 'invalid' || got.kind === 'unavailable' && cfg.transports === undefined || attempts >= MAX_ATTEMPTS;
		const status = !final ? 'queued' : got.kind === 'timeout' ? 'uncertain' : 'failed';
		const due = new Date(Date.parse(now) + Math.min(2 ** (attempts - 1) * 1000, 300_000)).toISOString();
		await db.write(sql(`UPDATE sys_message SET status = $2, error = $3, next_attempt_at = $4::timestamptz WHERE id = $1`, r['id']!, status, error.slice(0, 2000), due));
		if (status === 'failed' && r['record'] !== null) await patch(channel, r['record'] as Obj, 'failed', { at: now, message: r['id']!, reason: error.slice(0, 500) });
		return status === 'queued' ? 'retry' : status;
	}

	/**
	 * The `channels.deliver` run: builds record-driven rows in `seq` order, then sends the head of every conversation until
	 * none is due, and queues itself for the earliest retry. Concurrent deliverers are safe: a head is claimed by one
	 * conditional update, and a conversation's next row waits while any earlier row is queued or sending.
	 */
	async function deliver(): Promise<{ sent: number; failed: number }> {
		let sent = 0, failed = 0;
		await db.write(sql(`UPDATE sys_message SET status = 'skipped', error = 'queued in another environment epoch'
			WHERE direction = 'outbound' AND status IN ('queued', 'sending') AND coalesce(epoch, '') <> $1`, epoch));
		const [unbuilt] = await db.read([sql(`SELECT id, channel, record, rule FROM sys_message WHERE direction = 'outbound' AND status = 'queued'
			AND message IS NULL AND record IS NOT NULL ORDER BY seq LIMIT 1000`)]);
		for (const r of unbuilt!.rows) await build(r);
		for (let round = 0; round < 1000; round++) {
			const now = clock();
			const claimed = await db.write(sql(`UPDATE sys_message s SET status = 'sending', attempts = s.attempts + 1, claimed_at = $1::timestamptz
				WHERE s.direction = 'outbound' AND s.conversation IS NOT NULL AND s.message IS NOT NULL
					AND ((s.status = 'queued' AND s.next_attempt_at <= $1::timestamptz) OR (s.status = 'sending' AND s.claimed_at < $1::timestamptz - ${LEASE}))
					AND NOT EXISTS (SELECT 1 FROM sys_message p WHERE p.conversation = s.conversation AND p.direction = 'outbound'
						AND p.status IN ('queued', 'sending') AND p.seq < s.seq)
				RETURNING s.id, s.channel, s.conversation, s.message, s.record, s.attempts, (SELECT thread FROM sys_conversation c WHERE c.id = s.conversation) AS conv_thread`, now));
			if (claimed.rows.length === 0) break;
			for (const r of claimed.rows) {
				const x = await attempt(r);
				if (x === 'sent') sent++;
				else if (x !== 'retry') failed++;
			}
		}
		const [next] = await db.read([sql(`SELECT min(next_attempt_at)::text AS due FROM sys_message WHERE direction = 'outbound' AND status = 'queued'`)]);
		const due = next!.rows[0]?.['due'];
		if (typeof due === 'string' && Date.parse(due) > Date.parse(clock())) {
			const at = new Date(due).toISOString();
			await db.write(sql(`INSERT INTO sys_run (id, automation, input, due_at, key, cause, depth) VALUES (gen_random_uuid()::text, $1, '{}'::jsonb, $2::timestamptz,
				$3, 'schedule', 0) ON CONFLICT (key) DO NOTHING`, DELIVER, at, `${DELIVER}@${at}`));
			cfg.deadlines?.announce(cfg.scope ?? '', at);
		}
		return { sent, failed };
	}

	/**
	 * `notifications.deliver` (rule 47, §0.4 "Notifications"): each notice on a declared channel goes to the handle of
	 * every active member it names on that channel's transport (email address, WhatsApp number, Telegram chat), one send
	 * each, idempotent per notice and member; a member without a handle there is not reached. `{ policy }` names the
	 * members whose team holds it.
	 */
	async function notify(input: Json): Promise<Json> {
		const ids = isObj(input) && Array.isArray(input['ids']) ? input['ids'].map(String) : [];
		if (ids.length === 0) return { sent: 0, skipped: 0 };
		const [notes, users] = await db.read([
			sql(`SELECT id, recipient, title, body FROM sys_notification WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`, JSON.stringify(ids)),
			sql(`SELECT u.id, u.email, u.phone, u.telegram, t.name AS team FROM sys_user u LEFT JOIN sys_team t ON t.id = u.team WHERE u.active`),
		]);
		let sent = 0, skipped = 0;
		for (const n of notes!.rows) {
			const to = isObj(n['recipient']) ? n['recipient'] : {};
			const channel = String(to['channel'] ?? ''), list = Array.isArray(to['recipients']) ? to['recipients'].filter(isObj) : [];
			if (m.channels[channel] === undefined) { skipped++; continue; }
			const transport = transportOf(channel);
			const holds = (team: unknown, policy: string) => typeof team === 'string' && Object.entries(m.teams).some(([t, ps]) => t.toLowerCase() === team.toLowerCase() && ps.includes(policy));
			const members = users!.rows.filter((u) => list.some((r) => r['user'] === u['id']
				|| (typeof r['team'] === 'string' && typeof u['team'] === 'string' && r['team'].toLowerCase() === u['team'].toLowerCase())
				|| (typeof r['policy'] === 'string' && holds(u['team'], r['policy']))));
			const title = String(n['title']), text = typeof n['body'] === 'string' && n['body'] !== '' ? String(n['body']) : title;
			for (const u of members) {
				const handle = transport === 'email' ? u['email'] : transport === 'whatsapp' ? (typeof u['phone'] === 'string' ? `${u['phone'].replace(/\D/g, '')}@s.whatsapp.net` : null)
					: transport === 'telegram' ? u['telegram'] : null;
				if (typeof handle !== 'string' || handle === '' || handle === '@s.whatsapp.net') { skipped++; continue; }
				const message: Obj = transport === 'email' ? { to: [handle], subject: title, text } : { to: handle, text: text === title ? title : `${title}\n${text}` };
				await send(channel, message, { id: stableId('notice', String(n['id']), String(u['id'])) });
				sent++;
			}
		}
		return { sent, skipped };
	}

	return {
		receive, ingest, deliver, send, delivered, notify,
		/** Rule 61: the host's epoch; queued rows of any other epoch are skipped, never sent. */
		async activate(): Promise<void> {
			await db.write(sql(`INSERT INTO sys_config (key, value) VALUES ('channels.epoch', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, epoch));
		},
		/** Wires every transport's events to `receive`; a rejection is the adapter's redelivery. Returns the unsubscribe. */
		subscribe(): () => void {
			const offs = Object.values(cfg.transports ?? {}).filter((t): t is TransportPort => t !== undefined).map((t) => t.subscribe(receive));
			return () => { for (const off of offs) off(); };
		},
		/** The platform run the outbound pieces queue (rule 48): `runs.platform`. */
		handlers(): { readonly [name: string]: (input: Json) => Promise<Json> } {
			return { [DELIVER]: async () => await deliver(), [NOTIFY]: notify };
		},
	};
}
export type Channels = ReturnType<typeof channels>;
