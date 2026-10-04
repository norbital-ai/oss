import { envoyOn } from './registry.ts';
// Channels (rule 61, §3.3.8, §5.9, P24): the gateway for envoys, integrations and notifications. Inbound is durable
// before the provider is acknowledged and deduplicated by `(channel, provider_id)`; edits converge a row, revokes
// tombstone it. Outbound is at least once, serially per conversation in `seq` order, with outcome `sent | failed |
// uncertain`; delivery events and email replies are mapped back onto the causing row by an act as the channel's actor,
// which per-state `edit` never refuses (rule 41). Staff never speak into a thread here: replies come only from the channel (rule 61).
import type { Json } from '../../decl/values.ts';
import { catalogOf } from '../access/pred.ts';
import type {
	Authority,
	Bindings,
	DeadlinesPort,
	EngineActor,
	FilesPort,
	GuestPort,
	OutboundAttachment,
	Outcome,
	TransportEvent,
	TransportPort,
	Transports
} from '../contracts.ts';
import { BoltError, callPort, LIMITS } from '../contracts.ts';
import type { Engine } from '../index.ts';
import { mappingBody, type HttpPort } from '../integrations/runner.ts';
import * as ir from '../../protocol/ir.ts';
import { POLL } from '../runs/queue.ts';
import { Chain } from '../write/sql.ts';
import { checkOutbound, DELIVER, prepareSend, sendPiece, threadOf } from './outbound.ts';
import {
	conversationId,
	isObj,
	messageId,
	NOTIFY,
	preview,
	sql,
	stableId,
	type Obj
} from './store.ts';
import {
	isAutoReply,
	isReported,
	RANK,
	SendRefused,
	sendRefusal,
	TERMINAL,
	type DeliveryEntry,
	type DeliveryKind,
	type DeliveryReport
} from './status.ts';
import { decodeInbound, type Inbound } from './transports.ts';

export type { Transports };
const INTEGRATE = 'channels.integrate';
export type ChannelsConfig = {
	engine: Pick<Engine, 'manifest' | 'db' | 'act' | 'read' | 'authority'>;
	transports?: Transports;
	files?: FilesPort;
	guest?: GuestPort;
	/** The declared connections: a `custom` channel POSTs each outbound message to the connection its `send` names. */
	http?: HttpPort;
	/** Delivery retries wake the scope at their due time (rule 52a). */
	deadlines?: DeadlinesPort;
	scope?: string;
	clock?: () => string;
	/** The environment epoch (rule 61): rows of another epoch — a fork's, a restore's — are never sent. */
	epoch?: string;
	/** Rows the ingest newly wrote, once durable: the envoys area admits them. */
	admit?: (row: Ingested) => Promise<void>;
	/** Channel-sourced integrations (`engine.integrations.deliver`). */
	integrations?: { deliver(event: TransportEvent, run: string): Promise<unknown> };
};
/** One inbound row as the ingest wrote it. */
export type Ingested = Inbound & {
	row: string;
	channel: string;
	conversation: string;
	inserted: boolean;
	files: readonly Json[];
};
export type { DeliveryKind };
/** A timeline entry as stored: `raw` bounded to 4 KB. */
const entry = (e: DeliveryEntry): string => {
	const raw = e.raw === undefined ? undefined : JSON.stringify(e.raw);
	return JSON.stringify(
		raw === undefined || raw.length <= 4096 ? e : { ...e, raw: raw.slice(0, 4096) }
	);
};
/**
 * The status after kind `k` in SQL, the same rule as `statusAfter` (status.ts): terminal wins, `auto_replied` never moves
 * it, otherwise the higher rank. `t` / `r` are TERMINAL and RANK as JSON parameters.
 */
const AFTER = (
	col: string,
	k: string,
	t: string,
	r: string
) => `CASE WHEN ${k} = 'auto_replied' OR coalesce(${col}, '') IN (SELECT jsonb_array_elements_text(${t}::jsonb)) THEN ${col}
	WHEN ${k} IN (SELECT jsonb_array_elements_text(${t}::jsonb)) THEN ${k}
	WHEN (${r}::jsonb ->> ${k})::int > coalesce((${r}::jsonb ->> ${col})::int, 0) THEN ${k} ELSE ${col} END`;
const TERMINALS = JSON.stringify([...TERMINAL]),
	RANKS = JSON.stringify(RANK);
const MAX_ATTEMPTS = 8;
/** An admitted row (`role` set) keeps its transcript content; only unadmitted history is rewritten by an edit or a revoke. */
const KEEP = (col: string) =>
	`CASE WHEN sys_message.role IS NULL THEN excluded.${col} ELSE sys_message.${col} END`;
const TOMBSTONE = `text = CASE WHEN sys_message.role IS NULL THEN '' ELSE sys_message.text END, preview = CASE WHEN sys_message.role IS NULL THEN '' ELSE sys_message.preview END,
	files = CASE WHEN sys_message.role IS NULL THEN '[]'::jsonb ELSE sys_message.files END, email = CASE WHEN sys_message.role IS NULL THEN NULL ELSE sys_message.email END`;
const LEASE = `interval '10 minutes'`;

export function channels(cfg: ChannelsConfig) {
	const { manifest: m, db } = cfg.engine;
	const clock = cfg.clock ?? (() => new Date().toISOString());
	const epoch = cfg.epoch ?? '';
	const cat = catalogOf(m);
	const bindings = (): Bindings => {
		const now = clock();
		return { now, today: now.slice(0, 10), tz: m.workspace.tz, params: {} };
	};
	const specOf = (channel: string): Obj => {
		const s = m.channels[channel];
		if (s === undefined) throw new BoltError('unknownChannel', 'decode', `no channel '${channel}'`);
		return s as Obj;
	};
	const transportOf = (channel: string): string => String(specOf(channel)['transport']);
	/** The channel's own actor: exactly its declared `policies` (today's `channelSubject`). */
	const actorOf = (channel: string): Authority => {
		const actor: EngineActor = {
			kind: 'system',
			run: `channel:${channel}`,
			by: { platform: `channels.${channel}` }
		};
		return cfg.engine.authority(
			{
				actor,
				admin: false,
				policies: (specOf(channel)['policies'] as readonly string[] | undefined) ?? []
			},
			`channel:${String(specOf(channel)['type'] ?? channel)}`
		);
	};
	const body = (channel: string) =>
		mappingBody(
			{ engine: cfg.engine, ...(cfg.guest === undefined ? {} : { guest: cfg.guest }) },
			actorOf(channel),
			bindings(),
			`channel:${String(specOf(channel)['type'] ?? channel)}`
		);

	// ── inbound ──
	/** Stores the attachment bytes (files port, `sys_file` rows in the message's own statement); descriptors without bytes stay named. */
	async function files(
		inbound: Inbound,
		bins: readonly Uint8Array[] | undefined,
		c: Chain,
		now: string
	): Promise<Json[]> {
		const out: Json[] = [];
		for (const [i, a] of inbound.attachments.entries()) {
			const bytes = a.bin === undefined ? undefined : bins?.[a.bin];
			if (a.file !== undefined || bytes === undefined) {
				out.push({
					fileName: a.fileName,
					mimeType: a.mimeType,
					byteLength: a.byteLength,
					file: a.file ?? null
				});
				continue;
			}
			if (bytes.byteLength !== a.byteLength)
				throw new BoltError(
					'invalidInput',
					'decode',
					`attachment ${a.fileName} does not match its declared length`
				);
			const blob = await callPort('files', cfg.files, LIMITS.callMs.other, (p, signal) =>
				p.put(bytes, { name: a.fileName, mime: a.mimeType }, signal)
			);
			if ('kind' in blob)
				throw new BoltError('files', 'facility', 'message' in blob ? blob.message : blob.reason);
			const id = messageId('file', `${inbound.id}:${i}`);
			c.cte(
				`f${i}`,
				`INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at) VALUES (${c.p(id)}, ${c.p(a.fileName)}, ${c.p(a.mimeType)},
				${c.p(bytes.byteLength)}, ${c.p(blob.key)}, ${c.p(blob.sha256)}, 'sys_message.files', ${c.p(now)}::timestamptz) ON CONFLICT (id) DO NOTHING RETURNING id`
			);
			out.push({
				fileName: a.fileName,
				mimeType: a.mimeType,
				byteLength: a.byteLength,
				file: { id, name: a.fileName, mime: a.mimeType }
			});
		}
		return out;
	}

	/** One inbound message in one statement: its conversation, then the row (a newer version converges it, a revoke tombstones it). */
	async function ingest(
		channel: string,
		message: Json,
		bins?: readonly Uint8Array[]
	): Promise<Ingested | null> {
		const inbound = decodeInbound(transportOf(channel), message);
		if (inbound === null)
			throw new BoltError(
				'invalidInput',
				'decode',
				`the ${channel} adapter delivered a malformed message`
			);
		const now = clock(),
			c = new Chain();
		const conv = conversationId(channel, inbound.thread),
			id = messageId(channel, inbound.id);
		if (inbound.deleted && inbound.thread === '') {
			// a bare revoke: tombstone the row, or hold the id so the message never lands
			await db.write(
				sql(
					`WITH upd AS (UPDATE sys_message SET deleted_at = $3::timestamptz, ${TOMBSTONE} WHERE id = $1 AND deleted_at IS NULL RETURNING id)
				INSERT INTO sys_message (id, channel, direction, origin, provider_id, text, preview, deleted_at, created_at)
				SELECT $1, $2, 'inbound', 'live', $4, '', '', $3::timestamptz, $3::timestamptz WHERE NOT EXISTS (SELECT 1 FROM sys_message WHERE id = $1)
				ON CONFLICT (id) DO NOTHING`,
					id,
					channel,
					now,
					inbound.id
				)
			);
			return null;
		}
		const stored = inbound.deleted ? [] : await files(inbound, bins, c, now);
		const envoy = envoyOn(m, channel)?.[0] ?? null;
		// a group's name follows the provider's latest (a renamed group), never erased by a message that does not carry it
		c.cte(
			'conv',
			`INSERT INTO sys_conversation (id, channel, thread, kind, envoy, title, participants) VALUES (${c.p(conv)}, ${c.p(channel)}, ${c.p(inbound.thread)},
			${c.p(inbound.group ? 'group' : 'dm')}, ${c.p(envoy)}, ${c.p(inbound.title)}, ${c.p(typeof specOf(channel)['owner'] === 'string' ? inbound.participants ?? null : null)}::jsonb) ON CONFLICT (id) DO UPDATE SET
			envoy = excluded.envoy, title = coalesce(excluded.title, sys_conversation.title), participants = coalesce(excluded.participants, sys_conversation.participants)
			WHERE sys_conversation.envoy IS DISTINCT FROM excluded.envoy OR (excluded.title IS NOT NULL AND sys_conversation.title IS DISTINCT FROM excluded.title)
			OR (excluded.participants IS NOT NULL AND sys_conversation.participants IS DISTINCT FROM excluded.participants) RETURNING id`
		);
		const text = inbound.deleted ? '' : inbound.text;
		const source = typeof specOf(channel)['owner'] === 'string' && isObj(message) ? {
			sourceAccount: message['sourceAccount'] ?? null, sourceUser: message['sourceUser'] ?? null,
			thread: inbound.thread, group: inbound.group, title: inbound.title
		} : null;
		c.cte(
			'msg',
			`INSERT INTO sys_message (id, conversation, channel, direction, origin, provider_id, version, sender, sender_name, sent_at, invocation,
			preview, text, email, files, reply_to, deleted_at, message, created_at)
		VALUES (${c.p(id)}, ${c.p(conv)}, ${c.p(channel)}, ${c.p(typeof specOf(channel)['owner'] === 'string' && isObj(message) && message['direction'] === 'outbound' ? 'outbound' : 'inbound')}, ${c.p(inbound.history || typeof specOf(channel)['owner'] === 'string' ? 'sync' : 'live')}, ${c.p(inbound.id)}, ${c.p(inbound.version)},
			${c.p(inbound.sender)}, ${c.p(inbound.senderName)}, ${c.p(inbound.sentAt)}::timestamptz, ${c.p(inbound.invocation)}, ${c.p(preview(text))}, ${c.p(text)},
			${c.p(inbound.email)}::jsonb, ${c.p(stored)}::jsonb, ${c.p(inbound.replyTo)}, ${inbound.deleted ? `${c.p(now)}::timestamptz` : 'NULL'},
			${c.p(source)}::jsonb, ${c.p(now)}::timestamptz)
		ON CONFLICT (id) DO UPDATE SET ${
			inbound.deleted
				? `deleted_at = excluded.deleted_at, ${TOMBSTONE} WHERE sys_message.deleted_at IS NULL`
				: // an admitted row is the agent's transcript: an edit never rewrites what the model already saw
					`text = ${KEEP('text')}, preview = ${KEEP('preview')}, email = ${KEEP('email')}, files = ${KEEP('files')}, version = excluded.version,
				sender_name = coalesce(excluded.sender_name, sys_message.sender_name), message = coalesce(excluded.message, sys_message.message), edited_at = ${c.p(now)}::timestamptz
			WHERE sys_message.deleted_at IS NULL AND excluded.version > sys_message.version`
		}
		RETURNING (xmax = 0) AS inserted`
		);
		const integrationTargets = Object.entries(m.integrations).filter(([, spec]) => isObj(spec['source']) && spec['source']['channel'] === channel);
		const integrationJobs: { automation: string; key: string; input: Json }[] = integrationTargets.map(([collection]) => ({ automation: `${collection}.integration`, key: `channel:${channel}:${id}:${inbound.version}:${collection}`, input: { mode: 'deliver', message: isObj(message) ? { ...message, attachments: stored } : message } }));
		if (cfg.integrations !== undefined) integrationJobs.push({ automation: INTEGRATE, key: `channel:${channel}:${id}:${inbound.version}:integrations`, input: { mode: 'deliver', message: isObj(message) ? { ...message, attachments: stored } : message, channel, run: `channel:${channel}:${id}` } });
		if (!inbound.deleted && (typeof specOf(channel)['owner'] === 'string' || !inbound.history) && integrationJobs.length > 0) {
			c.cte('integrations', `INSERT INTO sys_run (id, automation, input, due_at, key, cause, depth)
				SELECT v.id, v.automation, v.input, ${c.p(now)}::timestamptz, v.key, 'inbound', 0
				FROM jsonb_to_recordset(${c.p(integrationJobs.map((job) => ({ id: crypto.randomUUID(), ...job })))}::jsonb) AS v(id text, automation text, input jsonb, key text)
				WHERE EXISTS (SELECT 1 FROM msg) ON CONFLICT (key) DO NOTHING RETURNING id`);
		}
		const [row] = (
			await db.write(
				c.sql(`(SELECT inserted FROM msg) AS inserted, (SELECT count(*) FROM msg)::int AS n`)
			)
		).rows;
		if (integrationJobs.length > 0 && Number(row!['n']) > 0) cfg.deadlines?.announce(cfg.scope ?? '', now);
		if (row!['n'] === 0) return null; // a redelivery, an older version, or a change to a tombstone: nothing moved
		return {
			...inbound,
			row: id,
			channel,
			conversation: conv,
			inserted: row!['inserted'] === true,
			files: stored
		};
	}

	/** Every transport event: inbound rows, then who reads them (envoys, integrations, email reply mapping); delivery events. */
	async function receive(event: TransportEvent): Promise<void> {
		if (event.kind === 'delivery') {
			if (isReported(event.report.kind))
				await delivered(event.channel, event.providerId, event.report);
			return;
		}
		// a custom channel's webhook hands over its verified request (`{ body, headers }`): the channel's own `inbound` maps it
		if (transportOf(event.channel) === 'custom') {
			for (const message of await mapped(event.channel, 'inbound', event.message)) {
				const account = isObj(event.message) ? event.message['sourceAccount'] : undefined;
				await arrived({ kind: 'inbound', channel: event.channel, message: typeof account === 'string' && isObj(message)
					? { ...message, sourceAccount: account, sourceUser: specOf(event.channel)['owner'] ?? null } : message });
			}
			return;
		}
		await arrived(event);
	}
	/** One decoded inbound message: its row, then who reads it (integrations, reply mapping, envoys). */
	async function arrived(event: Extract<TransportEvent, { kind: 'inbound' }>): Promise<void> {
		const got = await ingest(event.channel, event.message, event.bins);
		if (got === null || !got.inserted || got.deleted) return;
		const syncOnly = typeof specOf(event.channel)['owner'] === 'string';
		if (syncOnly) return;
		if (got.email !== null ? got.references.length > 0 : got.replyTo !== null) await replied(got);
		if (!got.history) await cfg.admit?.(got);
	}

	/** A custom channel's own decode, its declared `inbound` or `poll` `messages`, run as the channel's actor. */
	async function mapped(
		channel: string,
		from: 'inbound' | 'poll',
		payload: Json
	): Promise<readonly Json[]> {
		const out = await body(channel)(`channel.${String(specOf(channel)['type'] ?? channel)}.${from}.messages`, [{ ...(isObj(payload) ? payload : {}), configuration: specOf(channel)['configuration'] ?? {} }]);
		if (!Array.isArray(out))
			throw new BoltError(
				'invalidInput',
				'decode',
				`the ${channel} channel's ${from} messages answered no list`
			);
		return out as readonly Json[];
	}
	/** `channels.poll:<channel>` (its `poll.cron`): a GET through the named connection, its answer mapped and ingested like a webhook's. */
	async function poll(channel: string): Promise<Json> {
		const p = specOf(channel)['poll'] as Obj;
		const res = await callPort('http', cfg.http, LIMITS.callMs.http, (h, signal) =>
			h.request(
				String(p['connection']),
				{
					method: 'GET',
					path: String(p['path']),
					...(isObj(p['query']) ? { query: p['query'] as { readonly [name: string]: string } } : {})
				},
				signal
			)
		);
		if ('kind' in res)
			throw new BoltError(
				'upstream',
				'facility',
				`the ${channel} poll: ${'message' in res ? res.message : res.reason}`
			);
		if (res.status >= 400)
			throw new BoltError(
				'upstream',
				'facility',
				`the ${channel} poll: GET ${String(p['path'])} answered ${res.status}`
			);
		const messages = await mapped(channel, 'poll', { body: res.body });
		for (const message of messages) await arrived({ kind: 'inbound', channel, message });
		return { received: messages.length };
	}

	// ── delivery events → the timeline, the status, the causing row ──
	/**
	 * Appends `e` to the message's timeline and advances its status (status.ts); a redelivered report (same kind, time and
	 * code) moves nothing. The row's `events.<kind>` runs when the status moved, and for every reply and auto-reply.
	 */
	async function record(
		channel: string,
		where: string,
		params: readonly Json[],
		e: DeliveryEntry,
		extra: Obj = {}
	): Promise<Outcome | null> {
		const n = params.length,
			$ = (i: number) => `$${n + i}`;
		const same = JSON.stringify([
			{ kind: e.kind, at: e.at, ...(e.code === undefined ? {} : { code: e.code }) }
		]);
		const res = await db.write(
			sql(
				`WITH cur AS (SELECT id, status FROM sys_message WHERE ${where} AND direction = 'outbound' AND NOT delivery @> ${$(2)}::jsonb
				ORDER BY seq DESC LIMIT 1 FOR UPDATE)
			UPDATE sys_message s SET delivery = s.delivery || jsonb_build_array(${$(1)}::jsonb), status = ${AFTER('s.status', `${$(3)}::text`, $(4), $(5))},
				error = CASE WHEN ${$(3)} IN ('bounced', 'failed', 'complained', 'deferred') THEN coalesce(${$(6)}, s.error) ELSE s.error END,
				presume_at = CASE WHEN ${$(3)} IN ('sent', 'deferred', 'auto_replied') THEN s.presume_at END
			FROM cur WHERE s.id = cur.id RETURNING s.id, s.record, cur.status AS before, s.status`,
				...params,
				entry(e),
				same,
				e.kind,
				TERMINALS,
				RANKS,
				e.reason ?? null
			)
		);
		const row = res.rows[0];
		if (
			row === undefined ||
			(row['before'] === row['status'] && e.kind !== 'replied' && e.kind !== 'auto_replied')
		)
			return null;
		const { reply: _, ...fields } = e;
		return patch(channel, row['record'] as Obj | null, e.kind, {
			...fields,
			message: row['id']!,
			...extra
		});
	}
	const delivered = (
		channel: string,
		providerId: string,
		report: DeliveryReport
	): Promise<Outcome | null> =>
		record(
			channel,
			'channel = $1 AND provider_id = $2',
			[channel, providerId],
			report.reason === undefined && (report.kind === 'bounced' || report.kind === 'failed')
				? { ...report, reason: report.code ?? report.kind }
				: report
		);
	/**
	 * A reply is matched to its sending row by the outbound message's provider id or `thread` (an email's references, a
	 * chat's quoted message; rule 61). An automatic answer (RFC 3834) is `auto_replied`: recorded, never a reply.
	 */
	async function replied(got: Ingested): Promise<void> {
		const refs = got.email !== null ? [...got.references, got.thread] : [got.replyTo!];
		const mail = got.email;
		const auto =
			mail !== null &&
			isAutoReply(
				isObj(mail['headers']) ? (mail['headers'] as { [k: string]: string }) : {},
				String(mail['subject'] ?? '')
			);
		const reply: Json = mail ?? {
			id: got.id,
			thread: got.thread,
			sentAt: got.sentAt,
			from: { handle: got.sender, name: got.senderName },
			replyTo: got.replyTo,
			text: got.text,
			attachments: got.files
		};
		await record(
			got.channel,
			`channel = $1 AND (provider_id IN (SELECT jsonb_array_elements_text($2::jsonb)) OR thread IN (SELECT jsonb_array_elements_text($2::jsonb)))`,
			[got.channel, JSON.stringify(refs)],
			{ kind: auto ? 'auto_replied' : 'replied', at: got.sentAt, provider: 'bolt', reply: got.row },
			{ reply }
		);
	}
	/**
	 * `events.<kind>(e) → Patch`, applied as the channel's actor through the collection's pipeline. Per-state `edit` never
	 * refuses it (rule 41); a concurrent event on the same row is written again on a fresh read (a patch only sets values).
	 * ponytail: the manifest drops bodies, so an undeclared kind costs one isolate that answers `missingBody`.
	 */
	async function patch(
		channel: string,
		record: Obj | null,
		kind: DeliveryKind,
		event: Obj
	): Promise<Outcome | null> {
		if (
			record === null ||
			typeof record['collection'] !== 'string' ||
			typeof record['id'] !== 'string' ||
			cfg.guest === undefined
		)
			return null;
		let set: Json;
		try {
			set = await body(channel)(`channel.${String(specOf(channel)['type'] ?? channel)}.events.${kind}`, [event]);
		} catch (e) {
			if (e instanceof BoltError && e.code === 'missingBody') return null;
			return {
				kind: 'refused',
				code: 'invalidInput',
				message: `the ${kind} mapping failed: ${(e as Error).message}`
			};
		}
		if (!isObj(set) || Object.keys(set).length === 0) return null;
		const b = bindings(),
			authority = actorOf(channel);
		let outcome: Outcome | null = null;
		for (let attempt = 0; attempt < 5; attempt++) {
			const key = `channel:${channel}:${String(event['message'])}:${kind}:${attempt}`;
			outcome = (
				await cfg.engine.act({
					collection: record['collection'],
					verb: 'update',
					input: { target: record['id'], set },
					key,
					issuedAt: b.now,
					authority,
					bindings: b,
					invocationId: key,
					delivery: true
				})
			).outcome; // hook:envoys — `delivery`: rule 41's exception
			if (outcome.kind !== 'conflict') break;
		}
		return outcome;
	}

	// ── outbound ──
	/** `ctx.send`, an envoy reply, a notice: one queued row, committed, then delivered at once (best effort). */
	async function send(
		channel: string,
		message: Json,
		options: { kind?: 'dm' | 'group'; id?: string } = {}
	): Promise<string> {
		if (typeof specOf(channel)['owner'] === 'string')
			throw new BoltError(
				'invalidInput',
				'decode',
				`the ${channel} channel imports personal activity and cannot send`
			);
		const prepared = await prepareSend(m, db, channel, message);
		if ('error' in prepared) throw new BoltError('invalidInput', 'decode', prepared.error);
		const now = clock(),
			c = new Chain(),
			id = options.id ?? crypto.randomUUID();
		sendPiece(
			c,
			{ ...prepared, id, ...(options.kind === undefined ? {} : { kind: options.kind }) },
			now
		);
		await db.write(c.sql('(SELECT count(*) FROM sent)::int AS n'));
		cfg.deadlines?.announce(cfg.scope ?? '', now);
		await deliver().catch(() => undefined);
		return id;
	}

	/** Builds a record-driven row's message from the row as committed; `false` when it settled without one. */
	async function build(r: Obj): Promise<boolean> {
		const channel = String(r['channel']),
			record = r['record'] as Obj;
		const fail = async (status: 'failed' | 'skipped', error: string) => {
			const e: DeliveryEntry = {
				kind: 'failed',
				at: clock(),
				provider: 'bolt',
				reason: error.slice(0, 500),
				permanent: true
			};
			await db.write(
				sql(
					`UPDATE sys_message SET status = $2, error = $3, delivery = delivery || CASE WHEN $2 = 'failed' THEN jsonb_build_array($4::jsonb) ELSE '[]'::jsonb END
				WHERE id = $1 AND status = 'queued'`,
					r['id']!,
					status,
					error.slice(0, 2000),
					entry(e)
				)
			);
			if (status === 'failed') await patch(channel, record, 'failed', { ...e, message: r['id']! });
			return false;
		};
		const [row] = await cfg.engine
			.read(
				[ir.get(cat, String(record['collection']), String(record['id']))],
				{ as: 'workspace' },
				bindings()
			)
			.catch(() => [null]);
		if (row === null || row === undefined) return fail('skipped', 'the record no longer exists');
		// a row held for approval is not sent yet: the seal queues this delivery again, a rejection deletes the row
		if ((row as Obj)['approval_id'] != null) return false;
		let built: Json;
		try {
			built = await body(channel)(`channel.${String(specOf(channel)['type'] ?? channel)}.outbound.${String(r['rule'])}.message`, [
				{ record: row, configuration: specOf(channel)['configuration'] ?? {} }
			]);
		} catch (e) {
			return fail('failed', `the ${String(r['rule'])} message failed: ${(e as Error).message}`);
		}
		if (built === null)
			return fail('skipped', `the ${String(r['rule'])} message sends nothing for this record`);
		const checked = checkOutbound(transportOf(channel), built);
		if ('error' in checked)
			return fail('failed', `the message does not fit ${transportOf(channel)}: ${checked.error}`);
		const thread = await threadOf(m, db, channel, checked.message, String(record['id']));
		const conv = conversationId(channel, thread);
		const text =
			typeof checked.message['text'] === 'string'
				? checked.message['text']
				: String(checked.message['subject'] ?? '');
		await db.write(
			sql(
				`WITH conv AS (INSERT INTO sys_conversation (id, channel, thread, kind) VALUES ($2, $3, $4, 'dm') ON CONFLICT (id) DO NOTHING RETURNING id)
			UPDATE sys_message SET message = $5::jsonb, conversation = $2, thread = $6, text = $7, preview = $8 WHERE id = $1 AND status = 'queued'`,
				r['id']!,
				conv,
				channel,
				thread,
				JSON.stringify(checked.message),
				typeof checked.message['thread'] === 'string' ? checked.message['thread'] : null,
				text,
				preview(text)
			)
		);
		return true;
	}

	/** A custom channel's outbound: the wire message POSTed to its `send` connection; its `id` (or ours) is the provider id. */
	const customPort = (connection: string): TransportPort | undefined =>
		cfg.http === undefined
			? undefined
			: {
					async send(_channel, message, signal) {
						const res = await cfg.http!.request(
							connection,
							{ method: 'POST', path: '', body: message },
							signal
						);
						if (res.status < 200 || res.status >= 300)
							throw new Error(`connection '${connection}' answered ${res.status}`);
						const id = isObj(res.body) ? res.body['id'] : undefined;
						return {
							providerId: typeof id === 'string' && id !== '' ? id : String((message as Obj)['id'])
						};
					},
					subscribe: () => () => {}
				};

	/**
	 * A message's `attachments` (stored FileRefs) read for its provider, in order, at most `LIMITS.messageAttachmentBytes`
	 * together: a file no longer stored, or more than the cap, refuses the message for good; a failed read is retried.
	 */
	async function attachmentsOf(
		refs: readonly Json[],
		signal: AbortSignal
	): Promise<OutboundAttachment[]> {
		const ids = refs.map((a) => String((a as Obj)['id']));
		const [res] = await db.read([
			sql(
				`SELECT id, name, mime, size, key FROM sys_file WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
				JSON.stringify(ids)
			)
		]);
		const byId = new Map(res!.rows.map((f) => [String(f['id']), f]));
		const gone = ids.find((id) => !byId.has(id));
		if (gone !== undefined) throw new SendRefused(`attachment ${gone} is not a stored file`);
		const total = ids.reduce((n, id) => n + Number(byId.get(id)!['size']), 0),
			cap = LIMITS.messageAttachmentBytes;
		if (total > cap)
			throw new SendRefused(
				`the attachments are ${(total / 2 ** 20).toFixed(1)} MiB, over the ${cap / 2 ** 20} MiB a message carries`
			);
		const files = cfg.files;
		if (files === undefined) throw new SendRefused('this host stores no files to attach');
		let left = cap;
		const out: OutboundAttachment[] = [];
		for (const id of ids) {
			const f = byId.get(id)!,
				key = String(f['key']);
			const bytes = await files.get(key, left, signal);
			left -= bytes.byteLength;
			out.push({
				id,
				name: String(f['name']),
				mime: String(f['mime']),
				bytes,
				url: (expiresInS) => files.url(key, expiresInS, signal)
			});
		}
		return out;
	}

	/** One send attempt of a claimed head row, settled on the row. */
	async function attempt(r: Obj): Promise<'sent' | 'retry' | 'failed' | 'uncertain'> {
		const channel = String(r['channel']),
			transport = transportOf(channel),
			now = clock();
		const message = r['message'] as Obj;
		const [refs] = await db.read([
			sql(
				`SELECT provider_id FROM sys_message WHERE conversation = $1 AND provider_id IS NOT NULL AND id <> $2 ORDER BY seq DESC LIMIT 50`,
				r['conversation']!,
				r['id']!
			)
		]);
		const references = refs!.rows.map((x) => String(x['provider_id'])).reverse();
		const wire: Obj = {
			...message,
			id: String(r['id']),
			...(transport === 'email' ? {} : { to: String(r['conv_thread']) }),
			...(references.length === 0 ? {} : { inReplyTo: references.at(-1)!, references })
		};
		const port =
			transport === 'custom'
				? customPort(String(specOf(channel)['send']))
				: (cfg.transports as { [t: string]: TransportPort } | undefined)?.[transport];
		let thrown: unknown;
		const got = await callPort(
			'transport',
			port,
			LIMITS.callMs.http,
			async (p, signal) => {
				try {
					const refs = Array.isArray(message['attachments']) ? message['attachments'] : [];
					return await p.send(
						channel,
						wire,
						signal,
						refs.length === 0 ? undefined : await attachmentsOf(refs, signal)
					);
				} catch (e) {
					thrown = e;
					throw e;
				}
			},
			(x): x is { providerId: string; presumeAfterMs?: number } =>
				isObj(x) && typeof x['providerId'] === 'string' && x['providerId'] !== ''
		);
		const attempts = Number(r['attempts']);
		if (!('kind' in got)) {
			const presume =
				typeof got.presumeAfterMs === 'number' && got.presumeAfterMs > 0
					? new Date(Date.parse(now) + got.presumeAfterMs).toISOString()
					: null;
			await db.write(
				sql(
					`UPDATE sys_message SET status = 'sent', provider_id = $2, sent_at = $3::timestamptz, error = NULL, presume_at = $4::timestamptz,
				delivery = delivery || jsonb_build_array($5::jsonb) WHERE id = $1`,
					r['id']!,
					got.providerId,
					now,
					presume,
					entry({ kind: 'sent', at: now, provider: 'bolt' })
				)
			);
			if (r['record'] !== null)
				await patch(channel, r['record'] as Obj, 'sent', {
					kind: 'sent',
					at: now,
					provider: 'bolt',
					message: r['id']!
				});
			return 'sent';
		}
		const refusal = sendRefusal(thrown);
		const error = refusal?.message ?? ('message' in got ? got.message : got.reason);
		const final =
			refusal?.permanent === true ||
			got.kind === 'invalid' ||
			(got.kind === 'unavailable' && cfg.transports === undefined) ||
			attempts >= MAX_ATTEMPTS;
		const status = !final ? 'queued' : got.kind === 'timeout' ? 'uncertain' : 'failed';
		const due = new Date(
			Date.parse(now) + Math.min(2 ** (attempts - 1) * 1000, 300_000)
		).toISOString();
		// a retry is `deferred` on the timeline while the queue keeps the row `queued`; a timeout may have sent, so it records nothing
		const e: DeliveryEntry | null =
			status === 'uncertain'
				? null
				: {
						kind: status === 'queued' ? 'deferred' : 'failed',
						at: now,
						provider: 'bolt',
						reason: error.slice(0, 500),
						permanent: status === 'failed',
						...(refusal?.code === undefined ? {} : { code: refusal.code })
					};
		await db.write(
			sql(
				`UPDATE sys_message SET status = $2, error = $3, next_attempt_at = $4::timestamptz, delivery = delivery || coalesce($5::jsonb, '[]'::jsonb) WHERE id = $1`,
				r['id']!,
				status,
				error.slice(0, 2000),
				due,
				e === null ? null : `[${entry(e)}]`
			)
		);
		// the first retry and a final failure reach the row's `events` (a retry each time would re-patch the same state)
		if (e !== null && r['record'] !== null && (status === 'failed' || attempts === 1))
			await patch(channel, r['record'] as Obj, e.kind, { ...e, message: r['id']! });
		return status === 'queued' ? 'retry' : status;
	}

	/**
	 * The `channels.deliver` run: builds record-driven rows in `seq` order, then sends the head of every conversation until
	 * none is due, and queues itself for the earliest retry. Concurrent deliverers are safe: a head is claimed by one
	 * conditional update, and a conversation's next row waits while any earlier row is queued or sending.
	 */
	async function deliver(): Promise<{ sent: number; failed: number }> {
		let sent = 0,
			failed = 0;
		await db.write(
			sql(
				`UPDATE sys_message SET status = 'skipped', error = 'queued in another environment epoch'
			WHERE direction = 'outbound' AND status IN ('queued', 'sending') AND coalesce(epoch, '') <> $1`,
				epoch
			)
		);
		const [unbuilt] = await db.read([
			sql(`SELECT id, channel, record, rule FROM sys_message WHERE direction = 'outbound' AND status = 'queued'
			AND message IS NULL AND record IS NOT NULL ORDER BY seq LIMIT 1000`)
		]);
		for (const r of unbuilt!.rows) await build(r);
		for (let round = 0; round < 1000; round++) {
			const now = clock();
			const claimed = await db.write(
				sql(
					`UPDATE sys_message s SET status = 'sending', attempts = s.attempts + 1, claimed_at = $1::timestamptz
				WHERE s.direction = 'outbound' AND s.conversation IS NOT NULL AND s.message IS NOT NULL
					AND ((s.status = 'queued' AND s.next_attempt_at <= $1::timestamptz) OR (s.status = 'sending' AND s.claimed_at < $1::timestamptz - ${LEASE}))
					AND NOT EXISTS (SELECT 1 FROM sys_message p WHERE p.conversation = s.conversation AND p.direction = 'outbound'
						AND p.status IN ('queued', 'sending') AND p.seq < s.seq)
				RETURNING s.id, s.channel, s.conversation, s.message, s.record, s.attempts, (SELECT thread FROM sys_conversation c WHERE c.id = s.conversation) AS conv_thread`,
					now
				)
			);
			if (claimed.rows.length === 0) break;
			for (const r of claimed.rows) {
				const x = await attempt(r);
				if (x === 'sent') sent++;
				else if (x !== 'retry') failed++;
			}
		}
		// a quiet window passed with no delivered, bounced or failed report: delivered, presumed
		// ponytail: unindexed scan of outbound rows with a presume_at; add a partial index when outbound volume makes it show
		const now = clock();
		const [quiet] = await db.read([
			sql(
				`SELECT id, channel FROM sys_message WHERE direction = 'outbound' AND presume_at <= $1::timestamptz
			AND status IN ('sent', 'deferred') ORDER BY presume_at LIMIT 1000`,
				now
			)
		]);
		for (const r of quiet!.rows)
			await record(String(r['channel']), 'id = $1', [r['id']!], {
				kind: 'delivered',
				at: now,
				provider: 'bolt',
				presumed: true
			});
		const [next] = await db.read([
			sql(`SELECT least(min(next_attempt_at) FILTER (WHERE status = 'queued'), min(presume_at) FILTER (WHERE status IN ('sent', 'deferred')))::text AS due
			FROM sys_message WHERE direction = 'outbound' AND (status = 'queued' OR presume_at IS NOT NULL)`)
		]);
		const due = next!.rows[0]?.['due'];
		if (typeof due === 'string' && Date.parse(due) > Date.parse(clock())) {
			const at = new Date(due).toISOString();
			await db.write(
				sql(
					`INSERT INTO sys_run (id, automation, input, due_at, key, cause, depth) VALUES (gen_random_uuid()::text, $1, '{}'::jsonb, $2::timestamptz,
				$3, 'schedule', 0) ON CONFLICT (key) DO NOTHING`,
					DELIVER,
					at,
					`${DELIVER}@${at}`
				)
			);
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
			sql(
				`SELECT id, recipient, title, body FROM sys_notification WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
				JSON.stringify(ids)
			),
			sql(
				`SELECT u.id, u.email, u.phone, u.telegram, t.name AS team FROM sys_user u LEFT JOIN sys_team t ON t.id = u.team WHERE u.active`
			)
		]);
		let sent = 0,
			skipped = 0;
		for (const n of notes!.rows) {
			const to = isObj(n['recipient']) ? n['recipient'] : {};
			const channel = String(to['channel'] ?? ''),
				list = Array.isArray(to['recipients']) ? to['recipients'].filter(isObj) : [];
			if (m.channels[channel] === undefined) {
				skipped++;
				continue;
			}
			const transport = transportOf(channel);
			const holds = (team: unknown, policy: string) =>
				typeof team === 'string' &&
				Object.entries(m.teams).some(
					([t, ps]) => t.toLowerCase() === team.toLowerCase() && ps.includes(policy)
				);
			const members = users!.rows.filter((u) =>
				list.some(
					(r) =>
						r['user'] === u['id'] ||
						(typeof r['team'] === 'string' &&
							typeof u['team'] === 'string' &&
							r['team'].toLowerCase() === u['team'].toLowerCase()) ||
						(typeof r['policy'] === 'string' && holds(u['team'], r['policy']))
				)
			);
			const title = String(n['title']),
				text = typeof n['body'] === 'string' && n['body'] !== '' ? String(n['body']) : title;
			for (const u of members) {
				const handle =
					transport === 'email'
						? u['email']
						: transport === 'whatsapp'
							? typeof u['phone'] === 'string'
								? `${u['phone'].replace(/\D/g, '')}@s.whatsapp.net`
								: null
							: transport === 'telegram'
								? u['telegram']
								: null;
				if (typeof handle !== 'string' || handle === '' || handle === '@s.whatsapp.net') {
					skipped++;
					continue;
				}
				const message: Obj =
					transport === 'email'
						? { to: [handle], subject: title, text }
						: { to: handle, text: text === title ? title : `${title}\n${text}` };
				await send(channel, message, { id: stableId('notice', String(n['id']), String(u['id'])) });
				sent++;
			}
		}
		return { sent, skipped };
	}

	return {
		receive,
		ingest,
		deliver,
		send,
		delivered,
		notify,
		/** Rule 61: the host's epoch; queued rows of any other epoch are skipped, never sent. */
		async activate(): Promise<void> {
			await db.write(
				sql(
					`INSERT INTO sys_config (key, value) VALUES ('channels.epoch', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
					epoch
				)
			);
		},
		/** Wires every transport's events to `receive`; a rejection is the adapter's redelivery. Returns the unsubscribe. */
		subscribe(): () => void {
			const offs = Object.values(cfg.transports ?? {})
				.filter((t): t is TransportPort => t !== undefined)
				.map((t) => t.subscribe(receive));
			return () => {
				for (const off of offs) off();
			};
		},
		/** The platform run the outbound pieces queue (rule 48): `runs.platform`. */
		handlers(): { readonly [name: string]: (input: Json) => Promise<Json> } {
			const polls = Object.keys(m.channels)
				.filter((c) => isObj(m.channels[c]?.['poll']))
				.map((c) => [`${POLL}${c}`, async () => await poll(c)]);
			return {
				[DELIVER]: async () => await deliver(),
				[INTEGRATE]: async (input) => {
					if (!isObj(input) || typeof input['channel'] !== 'string' || input['message'] === undefined) throw new BoltError('invalidInput', 'decode', 'invalid channel integration delivery');
					await cfg.integrations?.deliver({ kind: 'inbound', channel: input['channel'], message: input['message'] }, String(input['run']));
					return null;
				},
				[NOTIFY]: notify,
				...Object.fromEntries(polls)
			};
		}
	};
}
export type Channels = ReturnType<typeof channels>;
