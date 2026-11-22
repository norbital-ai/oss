// Authority resolution, workspace skills, unheard events, and ToolContext construction (including sub-agent delegation).
import { Port, type SearchRequest, type WorkspaceNote } from '@norbital-ai/host-api';
import { Effect, FiberSet, Option, PubSub, Schema } from 'effect';
import type { Authority } from '../contracts.ts';
import { MSG } from '../conversations/store.ts';
import { sql } from '../db/sql.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { activeEnvoys, envoySpec } from '../envoys/spec.ts';
import type { EngineError } from '../errors.ts';
import { Authorities, preview_as } from '../identity/actor.ts';
import type { EngineManifest } from '../manifest.ts';
import type { Logs } from '../ports.ts';
import type { LiveShape } from '../services.ts';
import type { mcpSessions } from './mcp.ts';
import type { AgentStore } from './messages.ts';
import type { Queue as AgentMessageQueue } from './queue.ts';
import {
	clip,
	rowsOf,
	transcriptRow,
	type As,
	type ConversationRow,
	type MessageRow,
	type Plan
} from './schema.ts';
import {
	AGENT_LIMITS,
	approvedCalls,
	approvedPageSession,
	callKey,
	j,
	writesOf,
	type AgentConfig,
	type DrainOptions,
	type TurnState
} from './shared.ts';
import { AUTHORING_SKILLS, PLATFORM_SKILLS, platformFile } from './skills.ts';
import {
	JOBS,
	TEXT_FIRST_BYTES,
	type Audience,
	type jobs,
	type ToolContext,
	type Validators
} from './tools.ts';

export const makeWorkspaceSkills = (
	manifest: EngineManifest,
	skillFiles: AgentConfig['skill_files']
): ToolContext['skills'] => {
	// the platform's skills first, so a workspace skill of the same name replaces one
	const allSkills = { ...PLATFORM_SKILLS, ...manifest.agent.skills };
	return Object.fromEntries(
		Object.entries(allSkills).map(([name, skill]) => [
			name,
			{
				...skill,
				read: (path: string) => {
					if (name in manifest.agent.skills)
						return skillFiles === undefined
							? Port.unavailable('agent.skills', 'the host binds no skill files')
							: Port.attempt('agent.skills', () => skillFiles(name, path));
					const text = platformFile(name, path);
					return text === undefined
						? Port.unavailable('agent.skills', 'no such bundled reference')
						: Effect.succeed(new TextEncoder().encode(text));
				}
			}
		])
	);
};

export const makeAuthorityResolver = (
	config: AgentConfig,
	authorities: Authorities,
	db: TenantDbShape,
	publish: LiveShape['publish']
): ((as: As) => Effect.Effect<Authority | null, EngineError>) =>
	config.resolve ??
	Effect.fn('Agents.authority')(function* (as: As) {
		if ('member' in as) {
			if (as.preview !== undefined) {
				if (as.preview.team !== null && as.member !== as.preview.by) return null;
				const real = yield* authorities.member(db, publish, as.preview.by);
				if (real === null || !real.admin) return null;
				return (
					(yield* preview_as(
						real,
						authorities,
						db,
						publish,
						as.preview.team !== null
							? { team: as.preview.team }
							: as.preview.impersonate
								? { member: as.member }
								: as.member
					).pipe(
						Effect.catchTag('BoltError', (error) =>
							error.code === 'forbidden' || error.code === 'not_found'
								? Effect.succeed(null)
								: Effect.fail(error)
						)
					))?.authority ?? null
				);
			}
			const own = yield* authorities.member(db, publish, as.member);
			return as.team === undefined || own === null || own.actor.kind !== 'member'
				? own
				: yield* authorities.team(db, own.actor, as.team);
		}
		if ('envoy' in as)
			return yield* authorities.envoy(db, publish, {
				envoy: as.envoy.name,
				instance: as.envoy.instance,
				sender: as.envoy.sender,
				member: as.envoy.member,
				dm: as.envoy.dm
			});
		return yield* authorities.compile(
			{
				actor: { kind: 'system', run: as.run, by: { platform: 'agent' } },
				admin: false,
				policies: as.policies
			},
			`agent:${as.run}:${as.policies.join(',')}`
		);
	});

/** A public envoy's or an external member's turn: the external brief, and no view of the workspace's source. */
export const isOutward = Effect.fn('Agents.outward')(function* (
	db: TenantDbShape,
	conv: ConversationRow,
	a: Authority
) {
	const envoy = conv.envoy ?? (a.actor.kind === 'envoy' ? a.actor.envoy : null);
	return envoy !== null
		? (yield* envoySpec(db, envoy))?.audience === 'public'
		: a.actor.kind === 'member' && a.actor.external;
});

/** The workspace events a conversation has not heard: after its newest event row, else after its first row. */
export const unheardEvents = (db: TenantDbShape, config: AgentConfig, conversation: string) =>
	Effect.gen(function* () {
		const events = config.events;
		if (events === undefined) return [];
		const since = yield* db.value(
			Schema.NullOr(Schema.String),
			sql(
				`SELECT to_json(coalesce(max((meta->>'at')::timestamptz) FILTER (WHERE meta->>'tag' = 'event'), min(created_at)))#>>'{}'
				 FROM sys_message WHERE conversation = $1`,
				conversation
			)
		);
		if (since === null) return [];
		return (yield* Port.attempt('agent.events', () => events(since))).slice(
			-AGENT_LIMITS.eventsHeard
		);
	}).pipe(
		Effect.tapCause(Effect.logWarning),
		Effect.orElseSucceed((): readonly WorkspaceNote[] => [])
	);

export type BuildToolContextDeps = {
	readonly id: string;
	readonly turn: string;
	readonly config: AgentConfig;
	readonly logs: Logs['Service'];
	readonly store: AgentStore;
	readonly queue: AgentMessageQueue;
	readonly current: TurnState;
	readonly mcp: Effect.Success<ReturnType<typeof mcpSessions>>;
	readonly work: Effect.Success<ReturnType<typeof jobs>>;
	readonly workspaceSkills: ToolContext['skills'];
	readonly reading: Set<string>;
	readonly validators: Validators;
	readonly detached: FiberSet.FiberSet<unknown, never>;
	readonly reports: PubSub.PubSub<string>;
	readonly kick: (id: string) => Effect.Effect<void>;
	readonly drain: (
		id: string,
		options?: DrainOptions
	) => Effect.Effect<{ ran: boolean; reply: MessageRow | null }, EngineError>;
	readonly stop: (id: string) => Effect.Effect<void, EngineError>;
};

export const makeBuildToolContext = (deps: BuildToolContextDeps) => {
	const {
		id,
		turn,
		config,
		logs,
		store,
		queue,
		current,
		mcp,
		work,
		workspaceSkills,
		reading,
		validators,
		detached,
		reports,
		kick,
		drain,
		stop
	} = deps;
	const e = config.engine,
		m = e.manifest,
		db = e.db;
	const inApp = (conv: ConversationRow) => conv.envoy === null;

	return Effect.fn('Agents.context')(function* (
		conv: ConversationRow,
		authority: Authority,
		sender: As,
		rows: readonly MessageRow[],
		mode: ToolContext['mode'],
		external: boolean
	) {
		if (current.mcpTools === null || current.mcpFor !== authority.key) {
			current.mcpTools = yield* mcp.tools(authority);
			current.mcpFor = authority.key;
		}
		const envoy = conv.envoy === null ? undefined : yield* envoySpec(db, conv.envoy);
		const staff = authority.actor.kind === 'member' && !authority.actor.external;
		const hostSide = inApp(conv) && staff;
		const hostSkills = config.skills,
			search = config.search,
			draft = config.draft;
		const authoring =
			hostSide && draft !== undefined
				? yield* Port.attempt('agent.draft', () => draft(authority))
				: undefined;
		const host_tools = config.host_tools;
		const hostKey = `${authority.key}:${authoring !== undefined ? '1' : '0'}`;
		// once a turn for an actor: a tool's own call reads the state it depends on
		if (current.hostFor !== hostKey) {
			const loaded =
				!hostSide || host_tools === undefined
					? []
					: typeof host_tools === 'function'
						? yield* Port.attempt('agent.host_tools', () => host_tools(authority, id))
						: host_tools;
			current.host_tools =
				draft !== undefined && authoring === undefined
					? loaded.filter((tool) => tool.studio === undefined && tool.behavior.source_edit !== true)
					: loaded;
			current.hostFor = hostKey;
		}
		const audience: Audience = !inApp(conv) ? 'channel' : staff ? 'staff' : 'member';
		// the platform's skills by who can use them: authoring ones to authors, research and skill-authoring to in-app staff
		const skills: ToolContext['skills'] = {
			...Object.fromEntries(
				Object.entries(workspaceSkills).filter(
					([name]) =>
						name in m.agent.skills ||
						(AUTHORING_SKILLS.has(name)
							? authoring !== undefined
							: (name !== 'research' && name !== 'skill-authoring') || audience === 'staff')
				)
			),
			...(hostSide && hostSkills !== undefined
				? Object.fromEntries(
						Object.entries(yield* Port.attempt('agent.skills', () => hostSkills(authority))).map(
							([name, skill]) => [
								name,
								{
									...skill,
									read: (path: string) => Port.attempt('agent.skills', () => skill.read(path))
								}
							]
						)
					)
				: {})
		};
		const who = rows.findLast((r) => r.as !== null && r.role === 'user');
		const said = who === undefined || who.role === 'tool' ? null : who.content,
			tz = typeof said === 'object' ? said?.tz : undefined;
		const b = yield* config.bindings,
			ingester = e.convert?.ingest,
			approved = approvedCalls(rows),
			pageSession = approvedPageSession(rows);
		const ctx: ToolContext = {
			engine: e,
			conv,
			authority,
			bindings: b,
			turn,
			mode,
			inApp: inApp(conv),
			approved: (name, input) =>
				(name === 'page' && pageSession) || approved.delete(callKey(name, input)),
			tz,
			question: who?.text ?? undefined,
			child: conv.parent !== null,
			delegation:
				conv.parent === null && (conv.envoy === null ? staff : envoy?.delegation === 'enabled'),
			mcp,
			logs,
			mcpTools: current.mcpTools,
			host_tools: current.host_tools,
			browser_tools: config.browser_tools ?? [],
			attachments: config.attachments,
			...(ingester === undefined
				? {}
				: {
						ingest: (
							file: { sha256: string; name: string; mime: string; key: string; size: number },
							read: {
								readonly page?: number;
								readonly password?: string;
								readonly entry?: string;
							} = {}
						) =>
							ingester(
								{ sha256: file.sha256, name: file.name, mime: file.mime, key: file.key },
								{
									...(read.page !== undefined
										? { page: read.page }
										: file.size > TEXT_FIRST_BYTES
											? { pictures: false }
											: {}),
									...(read.password === undefined ? {} : { password: read.password }),
									...(read.entry === undefined ? {} : { entry: read.entry })
								}
							).pipe(Port.call('ingest', JOBS.ingestMs))
					}),
			// every inward agent reads the source (models, policies) for exact shapes; a public envoy's or external member's turn does not
			workspace: external ? undefined : config.workspace,
			...(hostSide && search !== undefined
				? { search: (request: SearchRequest) => search(authority, request) }
				: {}),
			draft: authoring,
			geocoder: config.geocoder,
			skills,
			agents: ['general', ...(yield* activeEnvoys(db)).map(({ id }) => id)],
			receipts: current.receipts,
			audience,
			zooms: current.zooms,
			reading,
			validators,
			files: current.files,
			jobs: work,
			inlineMs: config.host_inline_ms,
			setPlan: (body) =>
				store
					.setConv(
						id,
						'plan = $2::jsonb',
						j({
							revision: (conv.plan?.revision ?? 0) + 1,
							body,
							status: 'draft',
							checkpoint: 0,
							verdicts: 0
						} satisfies Plan)
					)
					.pipe(Effect.asVoid),
			ask: (text) => {
				if (current.question !== null) return false;
				current.question = text;
				return true;
			},
			messages: Effect.fn('Agents.messages')(function* (o: { limit: number; before?: number }) {
				const [result] = yield* db.read([
					sql(
						`SELECT ${MSG} FROM sys_message m WHERE conversation = $1 AND deleted_at IS NULL AND refused IS NULL AND coalesce(role, 'user') IN ('user', 'assistant') AND coalesce(state, '') <> 'scheduled' AND ($2::bigint IS NULL OR seq < $2) ORDER BY seq DESC LIMIT $3`,
						id,
						o.before ?? null,
						o.limit
					)
				]);
				return yield* rowsOf(result?.rows ?? []);
			}),
			output: Effect.fn('Agents.toolOutput')(function* (call) {
				const [result] = yield* db.read([
					sql(
						`SELECT meta->'full' AS full FROM sys_message WHERE conversation = $1 AND role = 'tool'
					AND ($2::text IS NULL OR content->>'id' = $2) AND meta->>'tag' IN ('output', 'confirm') AND meta ? 'full' ORDER BY seq DESC LIMIT 1`,
						id,
						call
					)
				]);
				return result?.rows[0]?.['full'] ?? undefined;
			}),
			history: Effect.fn('Agents.history')(function* (text, scope, limit) {
				const a = authority.actor,
					member = a.kind === 'member' ? a.id : a.kind === 'envoy' ? (a.linked?.id ?? null) : null; // a group turn searches no one's own
				// `dm: 'envoy'`: the member's own is their conversations on this instance alone, never their app or another envoy's
				const bound =
					a.kind === 'envoy' && (yield* envoySpec(db, a.envoy))?.dm === 'envoy' ? a.instance : null;
				const [r] = yield* db.read([
					sql(
						`SELECT m.conversation, m.seq, m.role, coalesce(m.author, m.sender_name, m.sender) AS author, left(m.text, 500) AS text, m.created_at::text AS at
						FROM sys_message m JOIN sys_conversation c ON c.id = m.conversation
						WHERE strpos(lower(m.text), lower($1)) > 0 AND m.role IN ('user', 'assistant') AND m.deleted_at IS NULL
							AND (m.conversation = $2 OR ($3::text IS NOT NULL AND CASE WHEN $5::text IS NULL THEN c.owner = $3 OR m."as"->>'member' = $3
								ELSE c.integration = $5 AND EXISTS (SELECT 1 FROM sys_message p WHERE p.conversation = c.id AND p."as"->'envoy'->>'member' = $3) END))
						ORDER BY m.seq DESC LIMIT $4`,
						text,
						id,
						scope === 'mine' ? member : null,
						limit,
						bound
					)
				]);
				return { hits: r?.rows ?? [] };
			}),
			heard: queue.heard(id),
			subagent: {
				// a sub-agent runs detached: this turn goes on (or ends), and its report arrives as a message here;
				// `task` names one of this conversation's to send it `prompt`, which a running turn takes at its next step
				task: Effect.fn('Agents.task')(function* ({ description, prompt, agent, task }) {
					if (task !== undefined) {
						if (!(yield* store.ownChild(id, task)))
							return { error: `Task ${task} is not a child of the current session` };
						const working = (yield* store.conversation(task)).status === 'running';
						yield* queue.post({
							conversation: task,
							as: sender,
							text: prompt,
							author: 'delegating agent'
						});
						yield* FiberSet.run(detached, kick(task));
						return { id: task, running: working };
					}
					// each child is a full agent loop in this host: cap the fan-out, not only the token spend
					if ((yield* store.runningChildren(id)) >= AGENT_LIMITS.subagents)
						return {
							error: `At most ${AGENT_LIMITS.subagents} tasks run at once; wait for one to finish first.`
						};
					const child = yield* store.start({
						parent: id,
						owner: conv.owner,
						// general: one like this agent, so an envoy's sub-agent is that envoy
						envoy: agent === 'general' ? conv.envoy : agent,
						model: conv.model,
						title: description.slice(0, 80)
					}); // no instance: nothing it says is sent
					yield* queue.post({
						conversation: child,
						as: sender,
						text: prompt,
						author: 'delegating agent'
					});
					yield* FiberSet.run(
						detached,
						drain(child).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
					);
					return { id: child, running: false };
				}),
				// what it did so far: its status, last messages, tool calls, the records it wrote (with the fields) and its source diffs
				read: Effect.fn('Agents.readTask')(function* (child) {
					if (!(yield* store.ownChild(id, child)))
						return { error: `Task ${child} is not a child of the current session` };
					const kid = yield* store.conversation(child);
					const rows = (yield* store.transcript(child)).flatMap((r) => {
						const row = transcriptRow(r, true, false);
						return row === null ? [] : [row];
					});
					const tools = rows.flatMap(({ tool }) => (tool === undefined ? [] : [tool]));
					return {
						status: kid.status,
						messages: rows
							.filter((r) => (r.role === 'user' || r.role === 'assistant') && !!r.text)
							.slice(-10)
							.map((r) => ({ role: r.role, text: r.text, ...(r.asked ? { asked: true } : {}) })),
						steps: tools
							.map((tool) => ({
								tool: tool.name,
								...(tool.running ? { running: true } : {}),
								...(tool.failed ? { failed: true } : {}),
								...(tool.args === undefined ? {} : { input: clip(tool.args, 200) }),
								...(tool.result === undefined ? {} : { result: clip(tool.result, 200) })
							}))
							.slice(-30),
						records: rows.flatMap((r) => r.receipts ?? []),
						writes: tools
							.flatMap((tool) => (tool.name === 'act' && !tool.failed ? writesOf(tool.args) : []))
							.slice(-50),
						source: tools
							.flatMap((tool) => (tool.failed ? [] : (tool.changes ?? [])))
							.slice(-20)
							.map((c) => ({ path: c.path, diff: clip(c.diff, 2000) })),
						files: rows.flatMap((r) => (r.role === 'tool' ? (r.files ?? []) : []))
					};
				}),
				stop: Effect.fn('Agents.stopTask')(function* (child) {
					return (yield* store.ownChild(id, child))
						? (yield* stop(child), { stopped: true })
						: { error: `Task ${child} is not a child of the current session` };
				}),
				running: () => store.runningChildren(id),
				// a report waiting in this conversation (it is claimed at the next step), or none at the bound
				report: (ms: number) =>
					Effect.scoped(
						Effect.gen(function* () {
							const subscription = yield* PubSub.subscribe(reports);
							const [pending] = yield* db.read([
								sql(
									`SELECT 1 FROM sys_message WHERE conversation = $1 AND state = 'queued' AND meta->>'tag' = 'report' LIMIT 1`,
									id
								)
							]);
							if ((pending?.rows.length ?? 0) > 0) return true;
							return Option.isSome(
								yield* PubSub.take(subscription).pipe(
									Effect.repeat({ until: (parent) => parent === id }),
									Effect.timeoutOption(ms)
								)
							);
						})
					)
			}
		};
		return { ctx, envoy };
	});
};
