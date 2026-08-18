import { createContext } from 'svelte';
import { Cause, Effect, Exit, Fiber, Result } from 'effect';

export type PlatformUser = Readonly<{
	readonly id: string;
	readonly norbital_id: string;
	readonly email?: string;
	readonly name?: string;
	readonly roles?: ReadonlyArray<string>;
}>;
/**
 * A channel as `workspace.manifest` publishes it — the authored declaration minus what only the
 * runtime needs.
 *
 * `audience` is `'public' | 'authenticated'`: who may reach the channel. It is typed as `string`
 * because this value crosses the wire as JSON from a workspace the client did not compile, and
 * narrowing it here would be a claim about a payload nothing validated. The consumers compare
 * against `'public'` and treat everything else as reachable only by members, which is the safe
 * reading of an unrecognised value.
 */
export type PlatformChannel = Readonly<{
	readonly name: string;
	readonly transport: string;
	readonly audience: string;
}>;
export type PlatformState = Readonly<{
	readonly user: PlatformUser;
	readonly organization: string;
	readonly apps: ReadonlyArray<string>;
	readonly channels: ReadonlyArray<PlatformChannel>;
}>;
export type ChatMessage = Readonly<{
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'tool';
	readonly content: string;
}>;
export type AgentUiState = Readonly<{
	readonly conversationId?: string;
	readonly messages: ReadonlyArray<ChatMessage>;
	readonly busy: boolean;
}>;
export type DetailLocation = Readonly<{ readonly collection: string; readonly recordId: string }>;
export type BoltRoute = Readonly<{ readonly app: string; readonly path: string }>;

const [readPlatformState, writePlatformState] = createContext<() => PlatformState>();
export const getPlatformStateContext = readPlatformState;
export const setPlatformStateContext = writePlatformState;

/** Owns push detail behavior at the state boundary so validation and typed semantics stay consistent for every caller. */
const PlatformNavigation = {
	pushDetail: (
		stack: ReadonlyArray<DetailLocation>,
		location: DetailLocation
	): ReadonlyArray<DetailLocation> => [...stack, location],
	popDetail: (stack: ReadonlyArray<DetailLocation>): ReadonlyArray<DetailLocation> =>
		stack.slice(0, -1),
	parseRoute: (pathname: string): BoltRoute => {
		const parts = pathname.split('/').filter(Boolean);
		return { app: parts[0] ?? '', path: `/${parts.slice(1).join('/')}` };
	}
};
export const pushDetail = PlatformNavigation.pushDetail;
/** Owns pop detail behavior at the state boundary so validation and typed semantics stay consistent for every caller. */
export const popDetail = PlatformNavigation.popDetail;

/** Owns parse route behavior at the state boundary so validation and typed semantics stay consistent for every caller. */
export const parseRoute = PlatformNavigation.parseRoute;

/** Owns latest query behavior at the state boundary so validation and typed semantics stay consistent for every caller. */
export class LatestQuery<T> {
	#fiber: Fiber.Fiber<T, unknown> | undefined;
	/** Owns run behavior at the state boundary so validation and typed semantics stay consistent for every caller. */
	readonly run = (query: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
		// A newer run supersedes the one in flight: the old fiber is interrupted, so its result can
		// never land after the new query's.
		this.#fiber?.interruptUnsafe();
		const fiber = Effect.runFork(Effect.tryPromise((signal) => query(signal)));
		this.#fiber = fiber;
		return Effect.runPromise(
			Fiber.await(fiber).pipe(
				Effect.map((exit) => {
					if (Exit.isSuccess(exit)) return exit.value;
					// A superseded run is interrupted; an interrupted fiber exits as a failure whose
					// cause carries no error — that is the "dropped" case, not a query failure.
					const failed = Cause.findError(exit.cause);
					if (Result.isSuccess(failed)) throw failed.success;
					return undefined;
				})
			)
		);
	};
	/** Owns invalidate behavior at the state boundary so validation and typed semantics stay consistent for every caller. */
	readonly invalidate = (): void => {
		this.#fiber?.interruptUnsafe();
		this.#fiber = undefined;
	};
}
