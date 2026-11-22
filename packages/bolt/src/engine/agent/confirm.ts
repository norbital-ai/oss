// Confirmation card validation, execution, and settlement.
import { Effect, type FiberSet } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Authority } from '../contracts.ts';
import { MSG } from '../conversations/store.ts';
import { sql } from '../db/sql.ts';
import type { EngineError } from '../errors.ts';
import { bounded, storedToolResult } from './context.ts';
import { isObj } from './draft.ts';
import type { AgentStore } from './messages.ts';
import { AgentRefusal, rowsOf, type As, type MessageRow, type Receipt } from './schema.ts';
import { ANSWERED, APPROVED, FIXED, j, type AgentConfig, type DrainOptions } from './shared.ts';
import { connectionFact, jobs, perform, performed, runJob } from './tools.ts';

export type ConfirmDeps = {
	readonly config: AgentConfig;
	readonly store: AgentStore;
	readonly resolve: (as: As) => Effect.Effect<Authority | null, EngineError>;
	readonly detached: FiberSet.FiberSet<unknown, never>;
	readonly watched: Set<string>;
	readonly steer: (
		conversation: string,
		as: As | null,
		lines: readonly string[]
	) => Effect.Effect<void>;
	readonly drain: (
		id: string,
		options?: DrainOptions
	) => Effect.Effect<{ ran: boolean; reply: MessageRow | null }, EngineError>;
};

export const makeConfirm = (deps: ConfirmDeps) => {
	const { config, store, resolve, detached, watched, steer, drain } = deps;
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
		const receipts = yield* store.withConfirmation(
			r.conversation,
			Effect.gen(function* () {
				const receipts: Receipt[] = [];
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
				const settle = (result: Json) => {
					const stored = storedToolResult(call.id, bounded(result).value, result);
					return store.changed(
						sql(
							`UPDATE sys_message m SET state = NULL, content = $2::jsonb, meta = CASE WHEN $3::jsonb IS NULL THEN meta - 'full' ELSE jsonb_set(meta, '{full}', $3::jsonb, true) END WHERE id = $1 AND state = 'approved' `,
							messageId,
							j({
								id: call.id,
								name: call.name,
								...(r.role === 'tool' ? { assistant: r.content.assistant } : {}),
								...(r.role === 'tool' && r.content.studio !== undefined
									? { studio: r.content.studio }
									: {}),
								...(r.role === 'tool' && r.content.view !== undefined
									? { view: r.content.view }
									: {}),
								result: stored.result
							}),
							j(stored.full)
						)
					);
				};
				const answer = Effect.gen(function* () {
					// a held `connect` answers the connection's state as it stands, whatever the card claimed
					if (call.name === 'connect') {
						const fact = yield* connectionFact(e, call.input);
						return approve ? fact : { declined: true, ...fact };
					}
					let result: Json = { declined: true };
					if (approve) {
						const authority = yield* resolve(as);
						if (authority === null) result = { error: FIXED.stale };
						// a held tool call (MCP, page control, run_js send, a host tool) runs when the agent makes it again
						else if (!performed(call.name))
							result = {
								approved: true,
								note:
									call.name === 'page'
										? 'The person approved page control for this conversation: repeat your call, and subsequent page actions run without prompting again.'
										: APPROVED
							};
						else {
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
							result = yield* Effect.scoped(
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
						}
					}
					return result;
				});
				const result = yield* answer.pipe(
					Effect.catch((failure) => Effect.succeed<Json>({ error: failure.message })),
					// the call can outlive this generation: the card still gets its answer
					Effect.onInterrupt(() =>
						settle({ error: FIXED.unreported }).pipe(
							Effect.tapCause(Effect.logWarning),
							Effect.ignore
						)
					)
				);
				yield* settle(result);
				return receipts;
			})
		);
		return yield* drain(r.conversation, { force: true, receipts });
	});
};
