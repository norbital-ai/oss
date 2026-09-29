// Envoys (P22's triggers, admission and registration, rules 57–60; today's `runtime/envoys/envoys.ts`; authority by P32).
// An envoy binds the agent to a channel, and every turn runs as the `envoy` actor. Senders are resolved to members by a
// verified handle under both audiences. A group turn holds exactly the envoy's `policies`; a DM holds the envoy's
// `policies` ∪ the linked sender's own authority (their policies, or the admin bypass). An unlinked sender's DM runs
// under the envoy's policies alone on a `public` envoy; on an `authenticated` one it gets the host-authored registration
// notice (`envoys.registration`, default 1 per 15 min per sender), sent to the sender privately, never into a group,
// and no turn. In a group, `groupMessages` decides what is addressed; the rest is ambient history `read_messages`
// reads. Each addressed message becomes the agent's queued input with its sender header (a steer: the running turn
// takes it at its next step). Every limit is the envoy's own: `envoys.receive` per sender and per subject, `agent` desk-wide.
import type { Json } from '../../decl/values.ts';
import { chargesFor, RateWindows } from '../access/rate.ts';
import type { Agents, As } from '../agent/index.ts';
import type { Authority } from '../contracts.ts';
import type { Channels, ChannelsConfig, Ingested } from '../channels/index.ts';
import { channels as openChannels } from '../channels/index.ts';
import { preview, sql, type Obj } from '../channels/store.ts';
import type { Engine } from '../index.ts';
import { Authorities } from '../identity/actor.ts';
import { DELIVER } from '../channels/outbound.ts';
import type { Triage } from '../agent/triage.ts';
import { canonicalHandle, inspectClaim, issueClaim, memberByHandle, redeemClaim, REGISTRATION_MINUTES } from './registration.ts';

export type EnvoysConfig = {
	engine: Pick<Engine, 'manifest' | 'db'>;
	channels: Pick<Channels, 'send' | 'deliver'>;
	agents: Pick<Agents, 'drain'>;
	authorities?: Authorities;
	clock?: () => string;
	/** The host's registration page for a claim (Bolt never names a host); default the workspace-relative path. */
	registrationLink?: (claim: string) => string;
	/** The name a notice uses for this workspace. */
	workspace?: string;
	/** Rule 60a: System 1 triage, when the host binds its port. */
	triage?: Pick<Triage, 'envoy' | 'hold' | 'release'>;
};
export type Admission = 'ignored' | 'ambient' | 'unregistered' | 'rateLimited' | 'queued' | 'pending';
/** Rule 59: fixed, recorded replies; internal text never reaches a sender. */
export const NOTICES = {
	rateLimited: 'You are sending messages faster than I can answer. Please wait a moment and send your message again.',
	register: (transport: string, workspace: string, link: string) =>
		[`Register this ${transport} account with ${workspace} to continue.`, '', 'Complete registration:', link, '', `This link expires in ${REGISTRATION_MINUTES} minutes.`].join('\n'),
} as const;

export function envoys(cfg: EnvoysConfig) {
	const { manifest: m, db } = cfg.engine;
	const clock = cfg.clock ?? (() => new Date().toISOString());
	const authorities = cfg.authorities ?? new Authorities(m, 'envoys');
	const windows = new RateWindows();
	/** One limited-message notice per sender per window, so a flood is never answered by a flood. */
	const warned = new Set<string>();
	const inflight = new Set<Promise<unknown>>();
	const link = cfg.registrationLink ?? ((claim: string) => `/__bolt/envoys/register?claim=${encodeURIComponent(claim)}`);
	const envoyOn = (channel: string): [string, Obj] | undefined => Object.entries(m.envoys).find(([, e]) => e['channel'] === channel) as [string, Obj] | undefined;
	const transportOf = (channel: string) => String(m.channels[channel]?.['transport']);

	/**
	 * Every limit is the envoy's own (P32, §3.9): `envoys.*` per sender and per subject, and rule 72's `agent` keyed by the
	 * envoy, so a desk's turns share one budget whoever sends (G12 (4)). A member's policies never add limits.
	 */
	const charge = async (envoy: string, channel: string, key: 'envoys.receive' | 'envoys.registration', sender: string, turn = false) => {
		const desk = (await authorities.envoy(db, { envoy, channel, sender, member: null, dm: false }))!;
		return windows.charge([...chargesFor(desk, [key], { sender: canonicalHandle(transportOf(channel), sender), subject: envoy }),
			...turn ? chargesFor(desk, ['agent'], { actor: envoy }) : []], Date.parse(clock()));
	};
	/** A fixed reply in the sender's conversation: the chat, or the mail thread (to the sender, `Re:` its subject). */
	const notify = (row: Ingested, text: string) => cfg.channels.send(row.channel, transportOf(row.channel) === 'email'
		? { to: [row.sender], subject: reSubject(row.email?.['subject']), text, thread: row.thread }
		: { to: row.conversation, text }, { kind: row.group ? 'group' : 'dm' });
	/** A notice only the sender may read (a registration link): their own DM, never the group that mentioned the envoy. */
	const tell = (row: Ingested, text: string) => row.group && transportOf(row.channel) !== 'email'
		? cfg.channels.send(row.channel, { to: row.sender, text }, { kind: 'dm' }) : notify(row, text);
	const mark = (row: string, set: string, ...params: Json[]) => db.write(sql(`UPDATE sys_message SET ${set} WHERE id = $1`, row, ...params));

	/**
	 * Rule 57 (P32): the sender, resolved to a member by a verified handle under both audiences; `null` for an unlinked
	 * sender to an `authenticated` envoy (the registration notice answers). A DM carries the member's authority; a group does not.
	 */
	async function subject(envoy: string, spec: Obj, row: Ingested): Promise<As | null> {
		const found = await memberByHandle(db, transportOf(row.channel), row.sender);
		const member = found !== null && await authorities.member(db, found) !== null ? found : null;
		if (member === null && spec['audience'] !== 'public') return null;
		return { envoy: { name: envoy, channel: row.channel, sender: row.sender, member, dm: !row.group } };
	}

	/** The envoy's half of ingest: one new live inbound row. */
	async function admit(row: Ingested): Promise<Admission> {
		const found = envoyOn(row.channel);
		if (found === undefined || row.history || row.deleted) return 'ignored';
		const [envoy, spec] = found;
		const groups = (spec['groupMessages'] as string | undefined) ?? 'disabled';
		if (row.group && groups === 'disabled') return 'ignored';
		const email = transportOf(row.channel) === 'email', trigger = row.invocation === 'mention' || row.invocation === 'reply';
		const addressed = !row.group || email || groups === 'all' || trigger;
		// rule 60a: never email, never a mention or reply (the deterministic trigger), only under the envoy's scope
		const triaged = !email && !trigger && cfg.triage?.envoy(spec, row.group) === true;
		if (!addressed && !triaged) {
			await mark(row.row, 'addressed = false');
			// A group message that named ids and was still not taken is the one case nobody can explain from outside: record
			// what the provider actually sent, so `Studio → Runtime` answers why a mention did not reach the envoy.
			if (row.group && row.mentions.length > 0)
				await db.write(sql(`INSERT INTO sys_event (at, severity, event, invocation, conversation, attributes) VALUES ($1::timestamptz, 'info', 'channel.unaddressed', $2, $3, $4::jsonb)`,
					clock(), row.row, row.conversation, JSON.stringify({ channel: row.channel, sender: row.sender, mentions: row.mentions, text: preview(row.text) })));
			return 'ambient';
		}

		const as = await subject(envoy, spec, row);
		// an unlinked sender's unaddressed message stays ambient: the notice answers only a mention or reply, as without triage
		if (as === null && !addressed) { await mark(row.row, 'addressed = false'); return 'ambient'; }
		if (as === null) {
			await mark(row.row, `addressed = true, refused = 'unregistered'`);
			if (!(await charge(envoy, row.channel, 'envoys.registration', row.sender)).ok) return 'unregistered';
			const claim = await issueClaim(db, envoy, transportOf(row.channel), row.sender, clock());
			if (claim !== null) await tell(row, NOTICES.register(transportOf(row.channel), cfg.workspace ?? 'this workspace', link(claim)));
			return 'unregistered';
		}
		// a triaged group row may become a turn, so it is charged like an addressed one; over the limit it stays ambient, unanswered
		const bounded = await charge(envoy, row.channel, 'envoys.receive', row.sender, true);
		if (!bounded.ok && !addressed) { await mark(row.row, 'addressed = false'); return 'ambient'; }
		if (!bounded.ok) {
			await mark(row.row, `addressed = true, refused = 'rateLimited'`);
			const key = `${envoy}\u0000${row.sender}\u0000${Math.floor(Date.parse(clock()) / 1000) + bounded.retryAfter}`;
			if (!warned.has(key)) { warned.add(key); await notify(row, NOTICES.rateLimited); }
			return 'rateLimited';
		}
		if (triaged) { await cfg.triage!.hold(row.conversation, sql(`UPDATE sys_message SET ${QUEUE('pending')} WHERE id = $1 RETURNING id`, row.row, JSON.stringify(as))); return 'pending'; }
		await cfg.triage?.release(row.conversation); // a trigger admits every pending row with it, and asks no decider
		await queue(row.row, as);
		track(drain(row.conversation));
		return 'queued';
	}
	/** Rule 60: the row itself becomes the agent's queued input under its own sender; one row is history and transcript. */
	const QUEUE = (state: 'queued' | 'pending') => `addressed = true, refused = NULL, role = 'user', state = '${state}', mode = 'agent', "as" = $2::jsonb,
		content = jsonb_build_object('text', coalesce(text, '')), author = coalesce(sender_name, sender)`;
	const queue = (row: string, as: As) => mark(row, QUEUE('queued'), JSON.stringify(as));
	const track = (p: Promise<unknown>) => { const x = p.catch(() => undefined).finally(() => inflight.delete(x)); inflight.add(x); };

	/**
	 * Runs the conversation's turn (the agent area owns it: one claimant per conversation, and a turn already running takes
	 * the new input at its next step), then ships what the turn wrote to the chat. Ownership: whoever's `drain` ran the
	 * turn ships its replies; a drain that found the turn running ships whatever that turn has finished so far.
	 */
	async function drain(conversation: string): Promise<{ ran: boolean; sent: number }> {
		const r = await cfg.agents.drain(conversation, { onWrite: live(conversation) });
		return { ran: r.ran, sent: await ship(conversation) };
	}
	/** Chat replies leave while the turn works: each finished assistant row is shipped as it is written (today's live updates). */
	const live = (conversation: string) => (row: { role: string | null }) => row.role === 'assistant' ? ship(conversation) : Promise.resolve(0);
	/**
	 * The turn's replies become the conversation's outbound rows (the same rows: transcript and outbox): on chat every
	 * finished assistant text (interim lines before tool calls, as today), on email only the final reply.
	 */
	async function ship(conversation: string): Promise<number> {
		const [res] = await db.read([sql(`SELECT c.channel, c.thread, (SELECT jsonb_build_object('sender', sender, 'subject', email->>'subject') FROM sys_message
			WHERE conversation = c.id AND direction = 'inbound' ORDER BY seq DESC LIMIT 1) AS last FROM sys_conversation c WHERE c.id = $1 AND c.channel IS NOT NULL`, conversation)]);
		const conv = res!.rows[0];
		if (conv === undefined) return 0;
		const channel = String(conv['channel']), email = transportOf(channel) === 'email', last = (conv['last'] ?? {}) as Obj;
		const message = email
			? `jsonb_build_object('to', jsonb_build_array($4::text), 'subject', $5::text, 'text', m.text, 'thread', $6::text)`
			: `jsonb_build_object('to', $1::text, 'text', m.text)`;
		const [row] = (await db.write(sql(`WITH out AS (UPDATE sys_message m SET direction = 'outbound', status = 'queued', channel = $2, message = ${message},
				epoch = coalesce((SELECT value FROM sys_config WHERE key = 'channels.epoch'), ''), sent_at = $3::timestamptz, next_attempt_at = $3::timestamptz
			WHERE m.conversation = $1 AND m.role = 'assistant' AND m.direction IS NULL AND coalesce(m.text, '') <> '' AND m.state IS DISTINCT FROM 'streaming'
				AND ${email ? `m.meta->>'tag' IN ('reply', 'failed')` : `(m.meta IS NULL OR m.meta->>'tag' IN ('reply', 'failed'))`} RETURNING m.id),
			run AS (INSERT INTO sys_run (id, automation, input, due_at, cause, depth) SELECT gen_random_uuid()::text, '${DELIVER}', '{}'::jsonb, $3::timestamptz, 'schedule', 0
				WHERE EXISTS (SELECT 1 FROM out) RETURNING id)
			SELECT (SELECT count(*) FROM out)::int AS n`, conversation, channel, clock(),
		...(email ? [String(last['sender'] ?? ''), reSubject(last['subject']), String(conv['thread'])] : [])))).rows;
		const n = Number(row!['n']);
		if (n > 0) await cfg.channels.deliver();
		return n;
	}

	return {
		admit, drain,
		/** The registration page's read-only probe: it shows the handle. */
		inspect: (claim: string) => inspectClaim(db, claim, clock()),
		/** The signed-in member claims the handle; with `replay` ticked, their unregistered messages of the window are admitted now. */
		async redeem(claim: string, authority: Authority, options: { replay?: boolean } = {}) {
			const r = await redeemClaim(db, claim, authority, clock(), options.replay === true);
			if (r.state === 'registered' || r.state === 'already_registered') for (const id of r.replay) {
				const row = await ingested(id);
				if (row !== null && row.sender !== '' && canonicalHandle(transportOf(row.channel), row.sender) !== '') await admit(row);
			}
			return r;
		},
		/** Every drain this instance started has finished (tests, a host's graceful stop). */
		async settled(): Promise<void> { while (inflight.size > 0) await Promise.all([...inflight]); },
	};

	/** An inbound row read back as the ingest reported it (registration replay). */
	async function ingested(id: string): Promise<Ingested | null> {
		const [res] = await db.read([sql(`SELECT m.id, m.channel, m.conversation, m.provider_id, m.sender, m.sender_name, m.text, m.files, m.email, m.invocation,
			m.reply_to, m.sent_at::text AS sent_at, c.thread, c.kind FROM sys_message m JOIN sys_conversation c ON c.id = m.conversation WHERE m.id = $1`, id)]);
		const r = res!.rows[0];
		if (r === undefined) return null;
		return { row: id, channel: String(r['channel']), conversation: String(r['conversation']), inserted: true, id: String(r['provider_id']),
			thread: String(r['thread']), sentAt: String(r['sent_at']), sender: String(r['sender'] ?? ''), senderName: r['sender_name'] as string | null,
			text: String(r['text'] ?? ''), replyTo: r['reply_to'] as string | null, group: r['kind'] === 'group', invocation: r['invocation'] as Ingested['invocation'],
			version: '', deleted: false, history: false, attachments: [], mentions: [], email: r['email'] as Obj | null, references: [], files: (r['files'] ?? []) as Json[] };
	}
}
export type Envoys = ReturnType<typeof envoys>;

const reSubject = (s: unknown): string => { const x = typeof s === 'string' ? s : ''; return /^re:/i.test(x) ? x : `Re: ${x}`; };

/**
 * A host's messaging: channels with the envoys on them (admission after ingest). `integrations` receive
 * channel-sourced deliveries.
 */
export function messaging(cfg: Omit<ChannelsConfig, 'admit'> & Omit<EnvoysConfig, 'channels' | 'engine'> & { engine: ChannelsConfig['engine'] }) {
	let desk: Envoys | undefined;
	const ch = openChannels({ ...cfg, admit: async (row) => { await desk!.admit(row); } });
	desk = envoys({ ...cfg, channels: ch });
	return { channels: ch, envoys: desk };
}
