// repository-health:allow SEM_PARALLEL -- automation-client consumes automation-schema over the
// #lib alias, so the pair is linked, not parallel.
// repository-health:allow SEM_PARALLEL -- client facade and runtime automations service are the
// two sides of the automations.* command protocol; they meet in client/runtime.ts, never directly.
import { Effect, Schema } from 'effect';
import type { AutomationProgression } from '#lib/authoring/automations-schema.js';
import type { RemoteQuery } from '@norbital-ai/std/collection';

/** The queue row projected to a browser watching one durable automation run. */
export const AutomationTaskSnapshot = Schema.Struct({
	status: Schema.Literals(['pending', 'paused', 'resuming', 'running', 'done', 'failed']),
	attempts: Schema.Number,
	maxAttempts: Schema.Number,
	error: Schema.NullOr(Schema.String),
	result: Schema.NullOr(Schema.Json),
	progress: Schema.NullOr(
		Schema.Struct({
			progress: Schema.Number,
			text: Schema.NullOr(Schema.String)
		})
	),
	progressSequence: Schema.Number,
	progressUpdatedAt: Schema.NullOr(Schema.String),
	/** The durable instant at which pending work becomes eligible to run again. */
	nextRunAt: Schema.NullOr(Schema.String)
});
export type AutomationTaskSnapshot = Schema.Schema.Type<typeof AutomationTaskSnapshot>;

export type AutomationRunSnapshot<Output = Schema.Json> = Omit<AutomationTaskSnapshot, 'result'> &
	Readonly<{ readonly result: Output | null }>;

/**
 * A live, query-owned view of one run.
 *
 * `current`, `loading`, and `error` are the ordinary live collection-query state. The replica owns
 * propagation; this surface performs no status requests after it starts the run.
 */
export interface AutomationRun<Output = Schema.Json> {
	readonly id: string;
	readonly current: AutomationRunSnapshot<Output> | null | undefined;
	readonly loading: boolean;
	readonly error: Error | undefined;
	// repository-health:allow EFF2 -- Automation lifecycle actions are generated browser actions and are Promise-shaped at the public client boundary.
	stop(): Promise<void>;
	// repository-health:allow EFF2 -- Automation lifecycle actions are generated browser actions and are Promise-shaped at the public client boundary.
	resume(): Promise<void>;
}

type AutomationModule = Readonly<{
	readonly spec: Readonly<{
		readonly input?: Schema.Top;
		readonly output?: Schema.Top;
	}>;
}>;

type InputOf<Definition extends AutomationModule> = Definition['spec'] extends {
	readonly input: infer Input extends Schema.Top;
}
	? Schema.Schema.Type<Input>
	: Readonly<Record<string, Schema.Json>>;
type OutputOf<Definition extends AutomationModule> = Definition['spec'] extends {
	readonly output: infer Output extends Schema.Top;
}
	? Schema.Schema.Type<Output>
	: Schema.Json;

type RunAutomation<Definition extends AutomationModule> = Definition['spec'] extends {
	readonly input: Schema.Top;
}
	? // repository-health:allow EFF2 -- Starting a generated browser automation is intentionally Promise-shaped at the public client boundary.
		(input: InputOf<Definition>) => Promise<AutomationRun<OutputOf<Definition>>>
	: // repository-health:allow EFF2 -- Starting a generated browser automation is intentionally Promise-shaped at the public client boundary.
		(input?: InputOf<Definition>) => Promise<AutomationRun<OutputOf<Definition>>>;

/** Exact generated automation registry projected into the browser client. */
export type AutomationClientApi<Registry extends Readonly<Record<string, AutomationModule>>> = {
	readonly [Name in keyof Registry]: Readonly<{
		readonly run: RunAutomation<Registry[Name]>;
		/** Stops the same durable run, retaining its input, progress and idempotency key. */
		// repository-health:allow EFF2 -- Automation lifecycle actions are generated browser actions and are Promise-shaped at the public client boundary.
		readonly stop: (taskId: string) => Promise<void>;
		/** Resumes the same stopped durable run and returns its live typed view. */
		// repository-health:allow EFF2 -- Automation lifecycle actions are generated browser actions and are Promise-shaped at the public client boundary.
		readonly resume: (taskId: string) => Promise<AutomationRun<OutputOf<Registry[Name]>>>;
		/** Active calls and durable runs started through this stable surface. */
		readonly pending: number;
		/** The most recently started run; its query owns progress, result, loading, and error state. */
		readonly latest: AutomationRun<OutputOf<Registry[Name]>> | undefined;
	}>;
};

type StartRun = (
	input: Schema.Json
) => Effect.Effect<Readonly<{ readonly taskId: string }>, unknown>;
type ReadRun = (taskId: string) => RemoteQuery<AutomationTaskSnapshot | null>;
type LifecycleRun = (taskId: string) => Effect.Effect<void, unknown>;

/**
 * One automation run backed only by the ordinary sync-aware collection query.
 *
 * There is no watcher, timer, refresh loop, SSE endpoint or socket here. The database trigger
 * projects `bolt_task` into `automation_run`; the existing replica stream applies its outbox row,
 * invalidates this query, and its local PGlite answer changes reactively.
 */
class ManagedAutomationRun implements AutomationRun {
	readonly id: string;
	readonly #query: RemoteQuery<AutomationTaskSnapshot | null>;
	readonly #stop: LifecycleRun;
	readonly #resume: LifecycleRun;

	constructor(
		id: string,
		query: RemoteQuery<AutomationTaskSnapshot | null>,
		stop: LifecycleRun,
		resume: LifecycleRun
	) {
		this.id = id;
		this.#query = query;
		this.#stop = stop;
		this.#resume = resume;
	}

	get current(): AutomationTaskSnapshot | null | undefined {
		return this.#query.current;
	}

	get loading(): boolean {
		return this.#query.loading;
	}

	get error(): Error | undefined {
		return this.#query.error;
	}

	// repository-health:allow EFF2 -- Automation lifecycle actions are generated browser actions and are Promise-shaped at the public client boundary.
	stop = (): Promise<void> => Effect.runPromise(this.#stop(this.id));

	// repository-health:allow EFF2 -- Automation lifecycle actions are generated browser actions and are Promise-shaped at the public client boundary.
	resume = (): Promise<void> => Effect.runPromise(this.#resume(this.id));
}

/** Stable Svelte state shared by every reader of one generated automation property. */
export class AutomationExecutionState {
	#starting = $state(0);
	latest = $state.raw<AutomationRun | undefined>(undefined);
	readonly #start: StartRun;
	readonly #read: ReadRun;
	readonly #stop: LifecycleRun;
	readonly #resume: LifecycleRun;
	#runs = $state.raw<ReadonlyArray<ManagedAutomationRun>>([]);

	constructor(start: StartRun, read: ReadRun, stop: LifecycleRun, resume: LifecycleRun) {
		this.#start = start;
		this.#read = read;
		this.#stop = stop;
		this.#resume = resume;
	}

	// repository-health:allow EFF2 -- Starting a generated browser automation is intentionally Promise-shaped at the public client boundary.
	run = (input: Schema.Json = {}): Promise<AutomationRun> => {
		this.#starting += 1;
		return Effect.runPromise(
			this.#start(input).pipe(
				Effect.map(({ taskId }) => {
					return this.#track(taskId);
				}),
				Effect.ensuring(Effect.sync(() => (this.#starting -= 1)))
			)
		);
	};

	get pending(): number {
		return (
			this.#starting +
			this.#runs.filter(({ current }) =>
				current === undefined || current === null
					? true
					: current.status !== 'done' && current.status !== 'failed'
			).length
		);
	}

	readonly #track = (taskId: string): ManagedAutomationRun => {
		const existing = this.#runs.find(({ id }) => id === taskId);
		if (existing !== undefined) return existing;
		const run = new ManagedAutomationRun(taskId, this.#read(taskId), this.#stop, this.#resume);
		this.#runs = [...this.#runs, run].slice(-50);
		this.latest = run;
		return run;
	};

	// repository-health:allow EFF2 -- Historical lifecycle actions are generated browser actions and are Promise-shaped at the public client boundary.
	stop = (taskId: string): Promise<void> =>
		this.#runs.find(({ id }) => id === taskId)?.stop() ?? Effect.runPromise(this.#stop(taskId));

	// repository-health:allow EFF2 -- Historical lifecycle actions are generated browser actions and are Promise-shaped at the public client boundary.
	resume = (taskId: string): Promise<AutomationRun> => {
		const existing = this.#runs.find(({ id }) => id === taskId);
		if (existing !== undefined) return existing.resume().then(() => existing);
		return Effect.runPromise(this.#resume(taskId)).then(() => this.#track(taskId));
	};
}

/** Runtime-erased surface; generated declarations restore each automation's exact input/output. */
export type ErasedAutomationClientApi = Readonly<
	Record<
		string,
		Readonly<{
			readonly run: AutomationExecutionState['run'];
			readonly stop: AutomationExecutionState['stop'];
			readonly resume: AutomationExecutionState['resume'];
			readonly pending: number;
			readonly latest: AutomationRun | undefined;
		}>
	>
>;

export type { AutomationProgression };
