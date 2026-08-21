import { createContext } from 'svelte';
import { Cause, Effect, Exit, Fiber, Result } from 'effect';

export type PlatformUser = Readonly<{
	/**
	 * The person, as the row they are: `bolt_auth_user.norbital_id`, the uuid every workspace column
	 * that points at a person holds.
	 *
	 * The only identity published here. There used to be a second field, `id`, carrying the same
	 * value under a name that did not say what the value was — and the shell filled both from the
	 * display name, so `where: { user_id: { eq: user.norbital_id } }` sent an email's local part to a
	 * `uuid` column and Postgres refused it as 22P02. Two spellings for one identity is what let a
	 * label sit in the key's slot unnoticed; the spelling kept is the one authored code already uses
	 * for a row's key everywhere else.
	 */
	readonly norbital_id: string;
	readonly email?: string;
	/**
	 * Whether this person administers the workspace: `bolt_auth_user.status`, as the host reports it.
	 *
	 * Separate from `team` because it is not one. The surfaces that ask "is this an administrator"
	 * used to look for the string `admin` in a roles array, which no workspace declares and nothing writes,
	 * so the answer was always no. Absent means no, so a host that does not supply it gets the
	 * narrower view rather than the wider one.
	 */
	readonly admin?: boolean;
}>;

/**
 * Three fields used to sit here and are deliberately gone: `name`, `team` and `organization`.
 *
 * Nothing read any of them — not bolt, not any of the six templates, not colony. `team` is the one
 * worth naming, because it was not merely dead: the shell filled it from the sidebar's role label,
 * so a field spelled like a team identity published the string `'Admin'` or `'Member'`. Authored
 * code that reached for it would have got a silent empty result rather than an error, which is
 * the same defect as the old `id`/`norbital_id` pair and harder to see. A label belongs to the
 * surface that renders it, not to the context authored queries key on.
 */
/**
 * An envoy as `workspace.manifest` publishes it — the authored declaration minus what only the
 * runtime needs.
 *
 * `audience` is `'public' | 'authenticated'`: who may reach the envoy. It is typed as `string`
 * because this value crosses the wire as JSON from a workspace the client did not compile, and
 * narrowing it here would be a claim about a payload nothing validated. The consumers compare
 * against `'public'` and treat everything else as reachable only by members, which is the safe
 * reading of an unrecognised value.
 *
 * There is no `agent` field. An envoy *is* an agent; the back-pointer this carried had the same
 * value for every envoy in every workspace, because there was only ever one agent to point at.
 */
export type PlatformEnvoy = Readonly<{
	readonly name: string;
	readonly transport: string;
	readonly audience: string;
}>;
export type PlatformState = Readonly<{
	readonly user: PlatformUser;
	readonly apps: ReadonlyArray<string>;
	readonly envoys: ReadonlyArray<PlatformEnvoy>;
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
