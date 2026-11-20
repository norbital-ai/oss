import { Deferred, Effect, FiberMap, FiberSet, Option } from 'effect';
import type { PortFailure, StudioRole, ToolBehavior } from '@norbital-ai/host-api';
import type { Json } from '../../../decl/values.ts';
import type { EngineError } from '../../errors.ts';
import { bounded } from '../context.ts';
import { isObj } from '../draft.ts';

/** Long work: a host call past 30 s (at most 10 minutes), an ingest. */
export const JOBS = { inlineMs: 30000, hostMs: 60000, waitMs: 120000, ingestMs: 600000 } as const;

export const jobId = () => globalThis.crypto.randomUUID().slice(0, 8);

export const jobFailed = (result: Json): string | undefined =>
	isObj(result) && typeof result['error'] === 'string' ? result['error'] : undefined;

/**
 * A turn's jobs. Each finished job leaves one steering line, taken once at the start of the turn's next step (`take`)
 * unless `wait` collected it first. A turn job is a child of the turn scope; a `detach`ed one (an ingest) runs on
 * `detached` and outlives the turn: what finishes after the turn closed, and what the turn left untaken, goes to `late`
 * (the agent queues it in the conversation and wakes it).
 */
export const jobs = Effect.fn('AgentTool.jobs')(function* (
	options: {
		readonly detached?: FiberSet.FiberSet<unknown, never>;
		readonly late?: (lines: readonly string[]) => Effect.Effect<void>;
		/** The runs this turn's jobs watch (by `alias`): their ends reach the agent here, never twice. */
		readonly watched?: Set<string>;
		/** A job ended with its owner's declared behavior. */
		readonly ended?: (answer: Json, behavior: ToolBehavior) => void;
		/**
		 * The durable record of a job no run stands for, open while it runs, so the next host reports one that died with
		 * its host. Given the line of a job whose turn closed, `close` makes the record that line; it answers whether the
		 * line is still the job's to deliver (not when a newer host already reported the job, or the record became it).
		 */
		readonly record?: {
			readonly open: (job: string, label: string) => Effect.Effect<string | undefined>;
			readonly close: (record: string, late: string | undefined) => Effect.Effect<boolean>;
		};
	} = {}
) {
	const fibers = yield* FiberMap.make<string, Json>();
	const late = options.late ?? (() => Effect.void);
	const all = new Map<
		string,
		{
			label: string;
			result: Deferred.Deferred<Json>;
			done: boolean;
			detached: boolean;
			alias: string | undefined;
			studio: StudioRole | undefined;
		}
	>();
	const lines = new Map<string, string>();
	let closed = false;
	yield* Effect.addFinalizer(() =>
		Effect.suspend(() => {
			closed = true;
			const left = [...lines.values()];
			lines.clear();
			return left.length === 0 ? Effect.void : late(left);
		})
	);
	return {
		add: Effect.fn('AgentTool.jobAdd')(function* (
			label: string,
			work: Effect.Effect<Json, EngineError | PortFailure>,
			o: {
				readonly detach?: boolean;
				readonly done?: (job: string, result: Json) => string;
				/** The whole line to the agent whichever way the job ended (a failure is the result, not something to report). */
				readonly alert?: (job: string, result: Json) => string;
				/** Another id `wait` and `has` know the job by (a run's id). */
				readonly alias?: string;
				/** The job's id when its work had to know it first (`jobId`). */
				readonly id?: string;
				/** The host reports the job's end itself (`HostTool.reports_end`): no record, and no line when it is cut short. */
				readonly reported?: true;
				readonly studio?: StudioRole;
				readonly behavior?: ToolBehavior;
			} = {}
		) {
			const id = o.id ?? jobId(),
				result = yield* Deferred.make<Json>();
			const detached = o.detach === true && options.detached !== undefined;
			const item = { label, result, done: false, detached, alias: o.alias, studio: o.studio };
			all.set(id, item);
			if (o.alias !== undefined) options.watched?.add(o.alias);
			const recorder = o.alias === undefined && o.reported === undefined ? options.record : undefined,
				record = recorder === undefined ? undefined : yield* recorder.open(id, label);
			const line = Effect.fnUntraced(function* (text: string) {
				if (recorder !== undefined && record !== undefined && !(yield* recorder.close(record, closed ? text : undefined)))
					return;
				if (!closed) lines.set(id, text);
				else yield* late([text]);
			});
			const run = work.pipe(
				Effect.catch((error) => Effect.succeed<Json>({ error: error.message })),
				Effect.tap((value) =>
					Effect.suspend(() => {
						item.done = true;
						const failed = jobFailed(value);
						options.ended?.(value, o.behavior ?? {});
						return line(
							o.alert?.(id, value) ??
								(failed !== undefined
									? `[job ${id} failed] ${label}: ${failed}`
									: (o.done?.(id, value) ??
										`[job ${id} done] ${label}: ${JSON.stringify(bounded(value).value)}`))
						);
					})
				),
				Effect.tap((value) => Deferred.succeed(result, value)),
				Effect.onInterrupt(() =>
					Effect.suspend(() => {
						item.done = true;
						if (o.alias !== undefined) {
							options.watched?.delete(o.alias);
							return Effect.void;
						}
						if (o.reported === true) return Effect.void;
						return line(`[job ${id} stopped] ${label}: cut short before it finished`);
					})
				)
			);
			if (detached && options.detached !== undefined)
				yield* FiberSet.run(options.detached, Effect.asVoid(run).pipe(Effect.ignore));
			else yield* FiberMap.run(fibers, id, run);
			return id;
		}),
		/** The first of `ids` (every job when none) to settle, collected: its steering line is not sent. */
		wait: Effect.fn('AgentTool.jobWait')(function* (ids: readonly string[], ms: number) {
			const open = [...all].filter(
				([id, item]) =>
					ids.length === 0 ||
					ids.includes(id) ||
					(item.alias !== undefined && ids.includes(item.alias))
			);
			if (open.length === 0) return null;
			const got = yield* Effect.raceAll(
				open.map(([id, item]) => Deferred.await(item.result).pipe(Effect.as(id)))
			).pipe(Effect.timeoutOption(ms));
			if (Option.isNone(got)) return null;
			const item = all.get(got.value);
			if (item === undefined) return null;
			const result = yield* Deferred.await(item.result);
			all.delete(got.value);
			lines.delete(got.value);
			return {
				job: got.value,
				label: item.label,
				result,
				...(item.studio === undefined ? {} : { studio: item.studio })
			};
		}),
		/** The finished jobs' steering lines, each once: the next step's input. */
		take: () => {
			const taken = [...lines];
			lines.clear();
			for (const [id] of taken) all.delete(id);
			return taken.map(([, line]) => line);
		},
		/** Whether every job of the turn (not a detached one) has finished, waiting at most `ms`. */
		settled: Effect.fn('AgentTool.jobsSettled')(function* (ms: number) {
			const open = [...all.values()].filter((item) => !item.detached && !item.done);
			if (open.length === 0) return true;
			return Option.isSome(
				yield* Effect.all(open.map((item) => Deferred.await(item.result))).pipe(
					Effect.timeoutOption(ms)
				)
			);
		}),
		pending: () => [...all].map(([id, item]) => ({ job: id, label: item.label, done: item.done })),
		/** Steering lines waiting for the next step. */
		ready: () => lines.size,
		/** Turn jobs still running: a reply meanwhile is interim. */
		running: () => [...all.values()].filter((item) => !item.detached && !item.done).length,
		has: (id: string) => all.has(id) || [...all.values()].some((item) => item.alias === id)
	};
});

export type Jobs = Effect.Success<ReturnType<typeof jobs>>;
