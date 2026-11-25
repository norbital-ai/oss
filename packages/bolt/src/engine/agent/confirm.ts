// Confirmation card validation, direct execution, and settlement.
import { Clock, Effect, type FiberSet, type PubSub } from 'effect';
import type { PortFailure } from '@norbital-ai/host-api';
import type { Json } from '../../decl/values.ts';
import type { Authority } from '../contracts.ts';
import { MSG } from '../conversations/store.ts';
import { sql } from '../db/sql.ts';
import type { EngineError } from '../errors.ts';
import { type Logs, Mcp } from '../ports.ts';
import { bounded, storedToolResult } from './context.ts';
import { isObj } from './draft.ts';
import { mcpSessions } from './mcp.ts';
import type { AgentStore } from './messages.ts';
import type { Queue as AgentMessageQueue } from './queue.ts';
import {
	AgentRefusal,
	rowsOf,
	storable,
	type As,
	type MessageRow,
	type Receipt
} from './schema.ts';
import {
	ANSWERED,
	callKey,
	FIXED,
	j,
	type AgentConfig,
	type DrainOptions,
	type TurnState
} from './shared.ts';
import {
	catalogue,
	connectionFact,
	jobs,
	perform,
	performed,
	runJob,
	type ToolContext,
	type Validators
} from './tools.ts';
import { isOutward, makeBuildToolContext } from './turn-context.ts';

export type ConfirmDeps = {
	readonly config: AgentConfig;
	readonly mcpPort: Mcp['Service'];
	readonly logs: Logs['Service'];
	readonly workspaceSkills: ToolContext['skills'];
	readonly store: AgentStore;
	readonly queue: AgentMessageQueue;
	readonly resolve: (as: As) => Effect.Effect<Authority | null, EngineError>;
	readonly detached: FiberSet.FiberSet<unknown, never>;
	readonly watched: Set<string>;
	readonly reading: Set<string>;
	readonly validators: Validators;
	readonly reports: PubSub.PubSub<string>;
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

export const makeConfirm = (deps: ConfirmDeps) => {
	const {
		config,
		mcpPort,
		logs,
		workspaceSkills,
		store,
		queue,
		resolve,
		detached,
		watched,
		reading,
		validators,
		reports,
		steer,
		kick,
		drain,
		stop
	} = deps;
	const e = config.engine,
		db = e.db;

	return Effect.fn('Agents.confirm')(function* (
		messageId: string,
		approve: boolean,
		by: Authority
	) {
		const [answer] = yield* db.read([
			sql(`SELECT ${MSG} FROM sys_message m WHERE id = $1`, messageId)
		]);
		const [r] = yield* rowsOf(answer?.rows ?? []);
		if (r === undefined || r.copied_from != null || r.meta?.tag !== 'confirm')
			return yield* new AgentRefusal({ message: 'nothing awaits confirmation here' });
		if (r.state !== 'confirm') return yield* new AgentRefusal({ message: ANSWERED });
		if (
			by.agent !== undefined ||
			by.actor.kind !== 'member' ||
			r.as === null ||
			!('member' in r.as) ||
			r.as.member !== by.actor.id
		)
			return yield* new AgentRefusal({
				message: 'only the person this turn serves can confirm it'
			});
		const as = r.as;
		const confirmation = r.meta;
		const settled = yield* store.withConfirmation(
			r.conversation,
			Effect.gen(function* () {
				const receipts: Receipt[] = [];
				const files: ToolContext['files'] = [];
				const startedAt = yield* Clock.currentTimeMillis;
				// one answer per card: the claim moves it out of `confirm` first, so a second press never runs the call again
				if (
					(yield* store.changed(
						sql(
							`UPDATE sys_message m SET state = 'approved' WHERE id = $1 AND state = 'confirm' `,
							messageId
						)
					)).length === 0
				)
					return yield* new AgentRefusal({ message: ANSWERED });
				const call = confirmation.call;
				const settle = Effect.fnUntraced(function* (
					shown: Json,
					whole: Json = shown,
					approved = false
				) {
					const stored = storedToolResult(call.id, shown, whole);
					const ms = (yield* Clock.currentTimeMillis) - startedAt;
					const base = r.role === 'tool' ? r.content : {};
					const content = storable({
						...base,
						id: call.id,
						name: call.name,
						ms,
						result: stored.result
					});
					const full = stored.full === undefined ? null : storable(stored.full);
					return yield* store.changed(
						sql(
							`UPDATE sys_message m SET state = NULL, content = $2::jsonb,
							meta = ((CASE WHEN $4::boolean THEN jsonb_set(meta, '{approved}', 'true'::jsonb, true) ELSE meta END) - 'full')
								|| CASE WHEN $3::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('full', $3::jsonb) END
							WHERE id = $1 AND state = 'approved' `,
							messageId,
							j(content),
							j(full),
							approved
						)
					);
				});
				const answer = Effect.gen(function* (): Effect.fn.Return<
					{ readonly shown: Json; readonly whole: Json },
					EngineError | PortFailure | AgentRefusal
				> {
					// a held `connect` answers the connection's state as it stands, whatever the card claimed
					if (call.name === 'connect') {
						const fact = yield* connectionFact(e, call.input);
						const out: Json = approve ? fact : { declined: true, ...fact };
						return { shown: bounded(out).value, whole: out };
					}
					if (!approve) return { shown: { declined: true }, whole: { declined: true } };
					const authority = yield* resolve(as);
					if (authority === null)
						return { shown: { error: FIXED.stale }, whole: { error: FIXED.stale } };
					if (performed(call.name)) {
						const started = yield* perform(
							{
								engine: e,
								authority,
								bindings: yield* config.bindings,
								turn: r.turn ?? r.id,
								conv: { id: r.conversation },
								receipts,
								// a confirmation card is the in-app agent's: a start records the conversation it came from
								agent: { conversation: r.conversation }
							},
							call.name,
							call.input,
							call.id
						);
						// a confirmed start is a job too: no turn holds it, so its end is queued and wakes the conversation
						const result = yield* Effect.scoped(
							Effect.flatMap(
								jobs({ detached, watched, late: (lines) => steer(r.conversation, as, lines) }),
								(once) =>
									runJob(
										once,
										e,
										authority,
										call.name === 'run' &&
											isObj(call.input) &&
											typeof call.input['automation'] === 'string'
											? `automation.${call.input['automation']}`
											: call.name,
										started
									)
							)
						);
						return { shown: bounded(result).value, whole: result };
					}
					// Direct execution for held tool calls (MCP, page, run_js, download, host tools, run_tool):
					// execute once with stored arguments and settle the real result directly, avoiding an extra LLM echo round-trip.
					return yield* Effect.scoped(
						Effect.gen(function* () {
							const conv = yield* store.conversation(r.conversation);
							const rows = yield* store.transcript(r.conversation);
							const external = yield* isOutward(db, conv, authority);
							const mcp = yield* mcpSessions(e.manifest, config.mcp).pipe(
								Effect.provideService(Mcp, mcpPort)
							);
							const once = yield* jobs({
								detached,
								watched,
								late: (lines) => steer(r.conversation, as, lines),
								record: {
									open: (job, label) => store.openJob(r.conversation, as, job, label),
									close: (record, late) => store.closeJob(r.conversation, record, late)
								}
							});
							const work: typeof once = {
								...once,
								add: (label, effect, o) => once.add(label, effect, { ...o, detach: true })
							};
							const turnState: TurnState = {
								model: conv.model,
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
								as,
								mode: 'agent',
								force: false,
								question: null,
								cut: null,
								reply: null,
								heard: false,
								typingIn: null,
								streaming: null,
								inputs: [],
								usage: { input: 0, output: 0, calls: 0 },
								receipts,
								zooms: new Map(),
								files,
								failures: new Map(),
								replayed: new Set(),
								mcpTools: null,
								mcpFor: '',
								host_tools: [],
								hostFor: ''
							};
							const buildContext = makeBuildToolContext({
								id: r.conversation,
								turn: r.turn ?? r.id,
								config,
								logs,
								store,
								queue,
								current: turnState,
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
							const { ctx } = yield* buildContext(conv, authority, as, rows, 'agent', external);
							const approvedKey =
								call.name === 'run_tool' && isObj(call.input) && typeof call.input['name'] === 'string'
									? callKey(call.input['name'], call.input['input'] ?? {})
									: callKey(call.name, call.input);
							const granted = new Set<string>([approvedKey]);
							const approvedCtx: ToolContext = {
								...ctx,
								approved: (name, input) =>
									(name === 'page' && call.name === 'page') ||
									granted.delete(callKey(name, input)) ||
									ctx.approved(name, input)
							};
							const toolset = yield* catalogue(approvedCtx);
							const executed = yield* toolset.run(call.name, call.input, call.id);
							for (const file of files) file.call ??= call.id;
							if ('confirm' in executed) {
								const errResult: Json = { error: 'This call could not be executed after approval.' };
								return { shown: errResult, whole: errResult };
							}
							const raw = executed.result;
							const own = 'bounded' in executed && executed.bounded === true;
							const whole = own && executed.full !== undefined ? executed.full : raw;
							const shown = own ? raw : bounded(raw).value;
							return { shown, whole };
						})
					);
				});
				const outcome = yield* answer.pipe(
					Effect.catch((failure) => {
						const errResult: Json = { error: failure.message };
						return Effect.succeed({ shown: errResult, whole: errResult });
					}),
					// the call can outlive this generation: the card still gets its answer
					Effect.onInterrupt(() =>
						settle({ error: FIXED.unreported }).pipe(
							Effect.tapCause(Effect.logWarning),
							Effect.ignore
						)
					)
				);
				yield* settle(outcome.shown, outcome.whole, approve);
				return { receipts, files };
			})
		);
		return yield* drain(r.conversation, {
			force: true,
			receipts: settled.receipts,
			files: settled.files
		});
	});
};
