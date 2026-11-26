// Turn lifecycle and step loop: claim, heartbeat, MCP session, step advancement, model streaming, recovery and exit cleanup.
import { type AiRequest, Port, Unavailable, uuidv7 } from '@norbital-ai/host-api';
import { Cause, Clock, Effect, Exit, type FiberSet, type PubSub, Schedule, type Scope } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import type { Authority } from '../contracts.ts';
import { claim as claimMessage } from '../conversations/store.ts';
import { sql } from '../db/sql.ts';
import type { EngineError } from '../errors.ts';
import type { makeParking } from '../parking.ts';
import { type Logs, Mcp, RunUnits } from '../ports.ts';
import { leaseUntil } from '../queue.ts';
import { Chain } from '../write/sql.ts';
import { isFacilityError, modelCall, overflow } from './ai.ts';
import {
	envoyName,
	pageNote,
	pageWaiting,
	projection,
	senderAsides,
	state,
	system,
	withStateNote
} from './context.ts';
import { mcpSessions } from './mcp.ts';
import type { AgentStore } from './messages.ts';
import type { Queue as AgentMessageQueue } from './queue.ts';
import { inApp, TASK, transcriptRow, type As, type MessageRow, type Meta, type Plan } from './schema.ts';
import { agentSettings, allowedModel, overLimit, overTaskLimit } from './settings.ts';
import {
	AGENT_LIMITS,
	checkFailing,
	FIXED,
	j,
	NUDGE,
	recordCheckProgress,
	stepKey,
	type AgentConfig,
	type DrainOptions,
	type TurnState
} from './shared.ts';
import { model_step } from './step.ts';
import {
	catalogue,
	catalogueNote,
	JOBS,
	jobs,
	turnFacts,
	type ToolContext,
	type Validators
} from './tools.ts';
import { makeExecuteCalls } from './turn-calls.ts';
import { audienceOf, isOutward, makeBuildToolContext, unheardEvents } from './turn-context.ts';
import { makeTurnIo } from './turn-io.ts';

export type TurnRunnerDeps = {
	readonly config: AgentConfig;
	readonly mcpPort: Mcp['Service'];
	readonly logs: Logs['Service'];
	readonly manifestHash: string;
	readonly workspaceSkills: ToolContext['skills'];
	readonly resolve: (as: As) => Effect.Effect<Authority | null, EngineError>;
	readonly store: AgentStore;
	readonly queue: AgentMessageQueue;
	readonly detached: FiberSet.FiberSet<unknown, never>;
	readonly watched: Set<string>;
	readonly stepping: ReturnType<typeof makeParking>;
	readonly reading: Set<string>;
	readonly validators: Validators;
	readonly reports: PubSub.PubSub<string>;
	readonly settle: (id: string) => Effect.Effect<boolean, EngineError>;
	readonly steer: (
		conversation: string,
		as: As | null,
		lines: readonly string[]
	) => Effect.Effect<void>;
	readonly kick: (id: string) => Effect.Effect<void>;
	readonly drain: (
		id: string,
		options?: DrainOptions
	) => Effect.Effect<{ ran: boolean; reply: MessageRow | null }, EngineError>;
	readonly stop: (id: string) => Effect.Effect<void, EngineError>;
};

export const makeTurnRunner = (deps: TurnRunnerDeps) => {
	const {
		config,
		mcpPort,
		logs,
		manifestHash,
		workspaceSkills,
		resolve,
		store,
		queue,
		detached,
		watched,
		stepping,
		reading,
		validators,
		reports,
		settle,
		steer,
		kick,
		drain,
		stop
	} = deps;
	const e = config.engine,
		m = e.manifest,
		db = e.db;

	return Effect.fn('Agents.drain')(function* (
		id: string,
		options: DrainOptions = {}
	): Effect.fn.Return<{ ran: boolean; reply: MessageRow | null }, EngineError, Scope.Scope> {
		// a card (native confirm or held Studio approval) waits for the person: only their own message — or, for Studio,
		// the host's decision/merge notice — starts the next turn; never a sibling's answer, background job or sub-agent
		const [held] = yield* db.read([
			sql(
				`SELECT 1 FROM sys_message m
				WHERE m.conversation = $1 AND m.role = 'tool' AND (
					(
						m.state = 'confirm'
						AND NOT EXISTS (
							SELECT 1 FROM sys_message u
							WHERE u.conversation = $1 AND u.role = 'user' AND u.state = 'queued'
							AND u.meta->>'tag' IS DISTINCT FROM 'report'
						)
					)
					OR (
						m.copied_from IS NULL
						AND jsonb_typeof(m.content->'result'->'approval'->'id') = 'string'
						AND NOT (m.content ? 'approval_result')
						AND NOT EXISTS (SELECT 1 FROM sys_conversation c WHERE c.id = $1 AND c.parent IS NOT NULL)
						AND NOT EXISTS (
							SELECT 1 FROM sys_message after
							WHERE after.conversation = $1 AND after.seq > m.seq
							AND after.state IS DISTINCT FROM 'cancelled'
							AND (
								after.role = 'assistant'
								OR (after.role = 'user' AND after.state = 'consumed' AND after.meta->>'tag' IS DISTINCT FROM 'report')
								OR (after.role = 'system' AND after.state = 'consumed' AND after.meta->>'notice' IS NOT NULL)
							)
						)
						AND NOT EXISTS (
							SELECT 1 FROM sys_message w
							WHERE w.conversation = $1 AND w.state = 'queued'
							AND (
								(w.role = 'user' AND w.meta->>'tag' IS DISTINCT FROM 'report')
								OR (w.role = 'system' AND w.meta->>'notice' IS NOT NULL)
							)
						)
					)
				) LIMIT 1`,
				id
			)
		]);
		if ((held?.rows.length ?? 0) > 0) return { ran: false, reply: null };
		const admitted = yield* store.claim(id);
		if (admitted === null) return { ran: false, reply: null };
		const turn = uuidv7();
		const started = yield* Clock.currentTimeMillis;
		const declined = { declined: true, reason: 'A new turn started before approval.' };
		yield* store.declinePending(id);
		// approvals are held for a person: an envoy's chat and a system agent's task hold none to reject
		const onTurnStart = config.on_turn_start;
		const rejected =
			onTurnStart === undefined || !inApp(yield* store.conversation(id))
				? []
				: yield* Port.attempt('agent.onTurnStart', () => onTurnStart(id)).pipe(
						Effect.mapError((error) => BoltError.make('internal', 'facility', error.message, error))
					);
		if (rejected.length > 0) {
			const ids = new Set(rejected);
			for (const row of yield* store.transcript(id)) {
				const approval = transcriptRow(row, true, false)?.tool?.approval;
				if (row.role !== 'tool' || approval === undefined || !ids.has(approval)) continue;
				yield* store.changed(
					sql(
						`UPDATE sys_message m SET content = content || jsonb_build_object('approval_result', $2::jsonb) WHERE id = $1`,
						row.id,
						j(declined)
					)
				);
			}
		}
		yield* Effect.gen(function* () {
			const now = (yield* config.bindings).now;
			yield* store.convChanged(
				sql(
					`UPDATE sys_conversation c SET lease_until = $2::timestamptz WHERE id = $1 AND status = 'running'`,
					id,
					leaseUntil(now, AGENT_LIMITS.leaseMs)
				)
			);
		}).pipe(
			Effect.tapCause(Effect.logWarning),
			Effect.ignore,
			Effect.repeat(Schedule.spaced(AGENT_LIMITS.heartbeatMs)),
			Effect.forkScoped
		);
		const mcp = yield* mcpSessions(m, config.mcp).pipe(Effect.provideService(Mcp, mcpPort));
		const current: TurnState = {
			model: '',
			audience: null,
			steps: 0,
			tool_errors: 0,
			failing: 0,
			checks: new Map(),
			lastError: '',
			cutTools: 0,
			compactions: 0,
			compactFailed: false,
			lastInput: 0,
			cached: 0,
			as: null,
			mode: 'agent',
			force: options.force === true,
			question: null,
			cut: null,
			reply: null,
			heard: true,
			typingIn: null,
			streaming: null,
			inputs: [],
			usage: { input: 0, output: 0, calls: 0 },
			receipts: [...(options.receipts ?? [])],
			zooms: new Map(),
			files: [...(options.files ?? [])],
			failures: new Map(),
			replayed: new Set(),
			mcpTools: null,
			mcpFor: '',
			host_tools: [],
			hostFor: ''
		};
		// Jobs that finish after the turn closes queue their report and wake it.
		const workBase = yield* jobs({
			detached,
			watched,
			late: (lines) => steer(id, current.as, lines),
			record: {
				open: (job, label) => store.openJob(id, current.as, job, label),
				close: (record, late) => store.closeJob(id, record, late)
			}
		});
		const work: typeof workBase = {
			...workBase,
			add: (label, effect, o) =>
				workBase.add(
					label,
					o?.behavior?.progress_check === true
						? effect.pipe(
								Effect.tap((value) =>
									Effect.sync(() => {
										recordCheckProgress(current.checks, label, checkFailing(value));
									})
								),
								Effect.tapError(() =>
									Effect.sync(() => {
										recordCheckProgress(current.checks, label, undefined);
									})
								)
							)
						: effect,
					o
				)
		};
		const io = yield* makeTurnIo({
			id,
			turn,
			config,
			logs,
			manifestHash,
			store,
			current,
			onWrite: options.onWrite
		});
		const executeCalls = makeExecuteCalls({ id, turn, store, io, current, settle });
		const buildContext = makeBuildToolContext({
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
		});

		const advance = Effect.fn('Agents.step')(function* () {
			// a planned close: the turn holds here, between steps, until its generation closes; its interruption hands it to
			// the next generation (`release`). ponytail: a parent in `wait` on a held sub-agent only ends at the host's cap
			stepping.leave(id);
			if (stepping.parked) yield* Effect.never;
			stepping.enter(id);
			// the CPU budget is a step's, not a turn's: a long turn is many small steps
			yield* (yield* RunUnits).next();
			// an administrator's runtime settings narrow the model and cap the month's spend (settings.ts)
			const settings = yield* agentSettings(db);
			const stored = yield* store.conversation(id);
			const conv = { ...stored, model: allowedModel(settings, stored.model) };
			current.model = conv.model;
			if (conv.status === 'stopped') return true;
			// `delivered_turn` marks each row new input at most once
			// one sender's inputs per step, oldest first; a later sender's steer is claimed at the next step under its own authority
			const claimChain = new Chain();
			const claimed = [
				...(yield* store.messageStatement(claimChain, claimMessage(claimChain, id, turn)))
			];
			claimed.sort((a, b) => a.seq - b.seq);
			const last = claimed.at(-1);
			if (last !== undefined) {
				current.heard = true;
				current.as = claimed.findLast((r) => r.as !== null)?.as ?? current.as;
				current.mode = last.mode ?? 'agent';
				current.inputs = claimed.map((r) => r.id);
				// a draft plan locks the conversation; only `execute_plan` starts execution
				if (current.mode === 'agent' && conv.plan?.status === 'draft' && conv.parent === null)
					current.mode = 'plan';
			} else if (current.steps === 0 && !current.force) {
				return yield* settle(id);
			}
			current.force = false;
			// each job that finished since the last step says so once, at the end of the context (the cached
			// prefix is unchanged)
			for (const line of work.take()) yield* io.appendNote(line);
			// workspace events since the conversation last heard one (or began): each once, never a turn of their own
			if (io.inApp(conv))
				for (const event of yield* unheardEvents(db, config, id)) {
					yield* io.systemRow(
						`Workspace event (${event.at}): ${event.title}${event.body === undefined ? '' : `\n${event.body}`}`,
						{ tag: 'event', at: event.at }
					);
				}
			if (current.as === null) {
				const prior = (yield* store.transcript(id)).findLast((r) => r.as !== null);
				current.as = prior?.as ?? null;
			}
			const sender = current.as;
			const authority = sender === null ? null : yield* resolve(sender);
			current.audience = audienceOf(conv, authority);
			const external = authority !== null && (yield* isOutward(db, conv, authority));
			// the brief is written for serving a person: a task's own prompt carries its rules
			const brief =
				authority === null || conv.kind === TASK
					? undefined
					: external
						? m.agent.external
						: m.agent.internal;
			if (sender === null || authority === null || (io.inApp(conv) && brief === undefined)) {
				yield* io.fail(
					conv,
					authority === null ? FIXED.stale : FIXED.unavailable,
					authority === null ? 'noAuthority' : 'noAgent'
				);
				return yield* settle(id);
			}
			// the tab answers a page step in a moment: what it then shows closes this step's context
			const seen = yield* store.modelRows(id, conv);
			let rows = pageWaiting(seen) ? yield* store.pageAnswer(id, conv) : seen;
			for (const aside of senderAsides(
				rows,
				conv,
				'envoy' in sender ? sender.envoy.sender : undefined
			))
				rows = [...rows, yield* io.systemRow(aside.text, { tag: 'aside', message: aside.message })];
			if (
				(yield* overLimit(
					db,
					settings,
					conv.owner,
					authority.policies,
					current.usage.cost ?? 0
				)) !== null ||
				(conv.kind === TASK &&
					(yield* overTaskLimit(db, settings, id, current.usage.cost ?? 0)) !== null)
			) {
				yield* io.fail(conv, FIXED.limit, 'spendLimit');
				yield* store.cancelQueued(id);
				return true;
			}
			if (current.steps >= AGENT_LIMITS.steps) {
				yield* io.fail(conv, FIXED.steps, 'stepCap');
				yield* store.cancelQueued(id);
				return true;
			}
			// `/compact` checkpoints under the agent's own prefix
			const { ctx, envoy } = yield* buildContext(
				conv,
				authority,
				sender,
				rows,
				current.mode === 'plan' ? 'plan' : 'agent',
				external
			);
			const toolset = yield* catalogue(ctx);
			// the catalogue as of the conversation's start (or its last checkpoint) holds its native MCP tools; a merge since
			// is one appended note of what changed, written when the conversation next runs
			const notes = projection(rows, conv).flatMap((row) =>
				row.role === 'system' && row.meta?.tag === 'note' && row.meta.catalogue !== undefined
					? [row.meta.catalogue]
					: []
			);
			const base = notes[0],
				native = base?.native ?? toolset.mcp;
			const catalogueText = catalogueNote(toolset.index, notes.at(-1)?.index);
			if (catalogueText !== undefined)
				rows = [
					...rows,
					yield* io.systemRow(catalogueText, {
						tag: 'note',
						catalogue: {
							index: toolset.index,
							...(base === undefined
								? {
										native: toolset.mcp.map(({ name, description, input }) => ({
											name,
											description,
											input
										}))
									}
								: {})
						}
					})
				];
			// one list for the conversation: its audience's tools, the host's, and the MCP tools it began with
			const offered = [...toolset.fixed, ...toolset.host, ...native];
			const prefix: Pick<AiRequest, 'system' | 'tools'> = {
				system: system({
					envoy: envoy === undefined ? undefined : envoyName(envoy.name),
					brief,
					task: envoy?.task,
					authors: ctx.draft !== undefined,
					authority
				}),
				tools: offered.map(({ name, description, input }) => ({ name, description, input }))
			};
			if (current.mode === 'compact') {
				// `/compact`: a checkpoint now, then the turn ends
				if (current.compactions < AGENT_LIMITS.compactions)
					yield* io.compact(conv, rows, [], 'manual', prefix);
				return yield* settle(id);
			}
			const configuredWindow = config.windows?.[conv.model];
			const catalog =
				configuredWindow !== undefined || config.ai === undefined
					? undefined
					: yield* config.ai.catalog.pipe(
							Effect.tapCause(Effect.logWarning),
							Effect.catch(() => Effect.succeed(undefined))
						);
			// a conversation on a class (`fast`, `default`, `strong`) resolves its window from the routed model
			const concrete = catalog?.models.some((x) => x.id === conv.model)
				? conv.model
				: conv.model === 'strong' &&
					  settings.strong != null &&
					  catalog?.models.some((x) => x.id === settings.strong)
					? settings.strong
					: conv.model === 'fast' &&
						  settings.system1 !== null &&
						  catalog?.models.some((x) => x.id === settings.system1)
						? settings.system1
						: catalog?.models.some((x) => x.id === settings.system2)
							? settings.system2
							: catalog?.default;
			// the model's own window, never a smaller host budget: compaction starts at 80% of what the model provides
			const window =
				configuredWindow ??
				catalog?.models.find((x) => x.id === concrete)?.context ??
				AGENT_LIMITS.window;
			if (
				current.lastInput > AGENT_LIMITS.compactAt * window &&
				current.compactions < AGENT_LIMITS.compactions &&
				!current.compactFailed &&
				current.cut === null
			) {
				yield* io.compact(conv, rows, current.inputs, 'automatic', prefix);
				return false;
			}
			// Reuse the frozen closing note during a multi-cut continuation so fresh timestamps or plan updates
			// never mutate the cached prefix before partial assistant segments.
			const note =
				current.cut !== null
					? current.cut.note
					: state(
							conv,
							current.mode === 'plan' ? 'plan' : 'agent',
							[turnFacts(e, authority, ctx.bindings, ctx.tz), pageNote(rows)]
								.filter((p): p is string => p !== undefined)
								.join('\n')
						);
			const history = withStateNote(rows, conv, note, { continuing: current.cut !== null });
			const request: AiRequest = {
				model: conv.model,
				purpose: 'chat',
				...prefix,
				messages: history,
				...(current.files.length === 0
					? {}
					: {
							files: current.files.map(({ mime, bytes, call }) => ({
								mime,
								bytes,
								...(call === undefined ? {} : { call })
							}))
						}),
				...(current.cut?.continuation === undefined
					? {}
					: { continuation: current.cut.continuation })
			};
			// shown on this request alone: what a request carries at its end, no later prefix holds
			current.files.length = 0;
			current.steps++;
			// the chat shows the assistant is on it while the model writes: a pending reply is silence the sender would read as being ignored
			if (current.heard) {
				current.heard = false;
				yield* io.startTyping(conv);
			}
			const live = yield* io.streamer(current.cut);
			current.streaming = live;
			const served = 'envoy' in sender ? sender.envoy.sender : undefined;
			const stepped = yield* model_step(
				io.observed(
					'chat',
					rows,
					conv,
					(onRequest) =>
						modelCall(config.ai, request, {
							onDelta: live.delta,
							onReasoning: live.reasoning,
							...io.wall,
							onRequest
						}),
					served
				),
				current.cut ?? undefined
			).pipe(Effect.catch((error) => Effect.succeed(error)));
			const partial: MessageRow | null = yield* live.end();
			current.streaming = null;
			if (isFacilityError(stepped)) {
				const r = stepped;
				// a failed step leaves no half reply: a continuation's row goes back to its cut, a fresh one goes
				if (partial !== null)
					yield* current.cut === null
						? store.discard(partial)
						: io.rewrite(
								partial,
								current.cut.row.content,
								current.cut.row.text,
								current.cut.row.meta
							);
				// past the window: a checkpoint from the newest part, and the turn fails at once when none can be written
				if (
					overflow(r) &&
					current.compactions < AGENT_LIMITS.compactions &&
					!current.compactFailed &&
					(yield* io.compact(conv, rows, current.inputs, 'automatic', prefix, true))
				)
					return false;
				if (/still writing a tool call/.test(r.message) && !current.cutTools++) {
					// once per turn: ask for smaller calls
					yield* io.appendNote(NUDGE.cutTool);
					return false;
				}
				// a provider's context refusal is not a service outage: name the one action that fixes it
				const contextOverflow = overflow(r);
				yield* io.fail(
					conv,
					contextOverflow ? FIXED.overflow : FIXED.failed,
					contextOverflow ? 'overflow' : r instanceof Unavailable ? 'unavailable' : r.kind,
					r instanceof Unavailable ? r.reason : r.message
				);
				return yield* settle(id);
			}
			const { response: r, text, reasoning, calls } = stepped;
			// a model step is progress: compaction may run again as often as a long turn needs
			current.compactions = 0;
			current.lastInput = r.usage.input;
			// a reply while background work runs is interim: the turn collects the work and goes on (a child's report-back)
			const collecting =
				r.finish !== 'cut' && calls.length === 0 && (work.running() > 0 || work.ready() > 0);
			const done = r.finish !== 'cut' && calls.length === 0 && !collecting;
			// a turn never settles on silence: an empty reply is answered visibly
			if (done && text.trim() === '' && current.cut === null) {
				// a reasoning-only reply is kept (the panel shows it)
				if (reasoning !== '')
					yield* io.reply(partial, { text: '', toolCalls: [], reasoning }, '', null);
				else if (partial !== null) yield* store.discard(partial);
				yield* io.fail(conv, FIXED.empty, 'emptyReply');
				return yield* settle(id);
			}
			// The reply is the model's own words: a receipt's record ids live in the row's `meta`, where the transcript
			// shows them as tool cards, and never in the text — an envoy turn is read on a phone by a person the
			// envoy prompt has told it not to hand ids to.
			const content = {
				text,
				toolCalls: calls,
				...(r.finish === 'cut' || current.cut !== null ? { segments: stepped.carry.segments } : {}),
				...(reasoning === '' ? {} : { reasoning })
			};
			const meta: Meta | null =
				r.finish === 'cut'
					? {
							tag: 'cut',
							...(r.continuation === undefined ? {} : { continuation: r.continuation })
						}
					: done
						? {
								tag: 'reply',
								receipts: [...current.receipts],
								usage: { ...current.usage, context: current.lastInput, window, model: conv.model }
							}
						: null;
			const row = yield* io.reply(partial, content, content.text, meta);
			if (r.finish === 'cut') {
				current.cut = { row, ...stepped.carry, note };
				return false;
			}
			current.cut = null;
			if (collecting) {
				// the finished jobs' messages open the next step
				if (!(yield* work.settled(JOBS.waitMs)))
					yield* io.appendNote('Background work did not finish in time.');
				return false;
			}
			if (done) {
				current.reply = row;
				current.receipts.length = 0;
				// The first gap report allows one correction. Verify that correction before settling.
				if (current.mode === 'agent' && conv.plan?.status === 'active' && conv.plan.verdicts < 2) {
					const proof = yield* store.transcript(id);
					const verdict = yield* io.verify(conv, conv.plan, proof, prefix);
					const gaps =
						verdict === null ? ['The verifier could not reach a verdict.'] : verdict.gaps;
					const note = [
						`Plan verification: ${verdict?.complete === true ? 'complete' : 'incomplete'}.`,
						verdict?.summary ?? '',
						...gaps.map((g) => `- ${g}`)
					]
						.filter((s) => s !== '')
						.join('\n');
					const status: Plan['status'] = verdict?.complete === true ? 'verified' : 'active';
					yield* store.setConv(
						id,
						'plan = $2::jsonb',
						j({ ...conv.plan, status, verdicts: conv.plan.verdicts + 1 })
					);
					yield* io.systemRow(
						note,
						{ tag: 'verdict', complete: verdict?.complete === true, gaps },
						verdict !== null && !verdict.complete && conv.plan.verdicts === 0
							? { state: 'queued', mode: 'agent', as: sender }
							: {}
					);
				}
				return yield* settle(id);
			}
			return yield* executeCalls(conv, sender, toolset, offered, row, calls, window);
		});

		yield* Effect.gen(function* () {
			// a turn taken over mid-work (its generation closed, its process died) goes on from its transcript and
			// answers; its input was already consumed, so only a turn that had replied or was waiting on a card settles
			if (admitted === 'takeover') {
				for (const row of yield* store.unfinished(id))
					if (row.role === 'tool')
						current.replayed.add(stepKey(row.content.name, row.content.args));
				const rows = yield* store.transcript(id),
					last = rows.at(-1);
				current.force ||=
					last?.meta?.tag !== 'reply' && last?.meta?.tag !== 'failed' && last?.state !== 'confirm';
				// cut mid-work, the transcript ends in the model's own rows: name the open request, or the resumed step
				// reads it as finished work to summarise
				const request = rows.findLast((r) => r.role === 'user' && r.state === 'consumed');
				if (
					current.force &&
					(last?.role === 'assistant' || last?.role === 'tool') &&
					request !== undefined
				)
					yield* io.appendNote(NUDGE.resumed(request.text ?? ''));
			}
			for (;;) {
				if (yield* advance()) break;
			}
		}).pipe(
			// a turn that breaks (a failure or a defect, never an interruption: a durable turn hands that turn on) answers its sender
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.gen(function* () {
							yield* Effect.logWarning(cause);
							const conv = yield* store.maybeConversation(id);
							const err = Cause.squash(cause);
							if (conv !== null)
								yield* io.fail(
									conv,
									FIXED.broke,
									'internal',
									err instanceof Error ? err.message : String(err)
								);
						})
			),
			Effect.onExit((exit) =>
				Effect.gen(function* () {
					stepping.leave(id);
					// no reply followed the typing it showed: the chat stops showing it
					yield* io.stopTyping(true);
					// Only an explicitly stopped turn can finish incomplete rows after an unhandled failure.
					// A leased turn retains its queued takeover and uncertain calls for the next owner.
					const stopped = (yield* store.maybeConversation(id))?.status === 'stopped';
					if (Exit.isFailure(exit) && !stopped) return;
					// a reply or a call the turn left unfinished (a stop, a crash) is finished as interrupted before the turn reads idle
					if (current.streaming !== null) yield* current.streaming.end(true);
					yield* store.unfinished(id, turn);
					// a turn that took no step and left no reply (nothing to hear, `/compact`) did nothing to sum up
					if (current.steps > 0 || current.reply !== null)
						yield* io.summary(stopped, (yield* Clock.currentTimeMillis) - started);
					if (Exit.isFailure(exit)) return;
					yield* store.idle(id, false);
				}).pipe(Effect.tapCause(Effect.logWarning))
			)
		);
		return { ran: true, reply: current.reply };
	});
};
