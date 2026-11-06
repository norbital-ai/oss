import { Context, Effect, Layer } from 'effect';
import type { EngineError } from '../errors.ts';
import { enqueue } from '../runs/queue.ts';
import type { Chain } from '../write/sql.ts';
import { BoltError } from '../../protocol/errors.ts';
import { Turns, type TurnVia } from '../services.ts';

export const TURN_RUN = 'agent.turn';
/** A running turn renews this lease; past it the queued run takes the conversation over (rule 48). */
export const TURN_LEASE_MS = 180_000;
/** The conversation's one queued `agent.turn` run, due at `due`: input is answered if the process that took it dies. */
export const enqueueTurn = (chain: Chain, conversation: string, due: string, when = 'true') =>
	enqueue(chain, {
		select: `SELECT '${TURN_RUN}'::text AS automation,
        jsonb_build_object('conversation', ${chain.p(conversation)}::text) AS input, ${chain.p(due)}::timestamptz AS due_at, 'schedule'::text AS cause, 0 AS depth
        WHERE ${when} AND NOT EXISTS (SELECT 1 FROM sys_run WHERE automation = '${TURN_RUN}' AND state = 'queued' AND input->>'conversation' = ${chain.p(conversation)})`
	});

type Drain = (conversation: string) => Effect.Effect<{ readonly ran: boolean }, EngineError>;
export class TurnHandlers extends Context.Service<
	TurnHandlers,
	{
		readonly register: (via: TurnVia, drain: Drain) => Effect.Effect<void>;
		readonly release: (
			release: (conversation: string) => Effect.Effect<void, EngineError>
		) => Effect.Effect<void>;
		readonly drain: (
			conversation: string,
			via: TurnVia
		) => Effect.Effect<{ readonly ran: boolean }, EngineError>;
		readonly pending: (conversation: string) => Effect.Effect<void, EngineError>;
	}
>()('bolt/TurnHandlers') {}

const handlers = Layer.effect(
	TurnHandlers,
	Effect.sync(() => {
		const drains = new Map<TurnVia, Drain>();
		let release: (conversation: string) => Effect.Effect<void, EngineError> = () => Effect.void;
		return {
			register: (via: TurnVia, drain: Drain) =>
				Effect.sync(() => {
					drains.set(via, drain);
				}),
			release: (next: typeof release) =>
				Effect.sync(() => {
					release = next;
				}),
			drain: (conversation: string, via: TurnVia) =>
				Effect.suspend(() => {
					const drain = drains.get(via);
					return drain === undefined
						? Effect.fail(
								BoltError.make('notReady', 'guest', `the ${via} turn handler is not registered`)
							)
						: drain(conversation);
				}),
			pending: (conversation: string) => Effect.suspend(() => release(conversation))
		};
	})
);

/** The bottom dispatcher lets agents, envoys and triage register without a dependency cycle. */
export const TurnsLive = Layer.effect(
	Turns,
	Effect.gen(function* () {
		const registry = yield* TurnHandlers;
		return { drain: registry.drain, release: registry.pending };
	})
).pipe(Layer.provideMerge(handlers));
