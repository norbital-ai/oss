// The host's guest runner: isolates it makes, meters and ends for a release's guest code, driven through the
// release's prelude (`take`, `start`, `give`).
import { Schema } from 'effect';

/** Values produced by the tenant-controlled prelude, decoded before the host or engine consumes them. */
export const GuestFinalSchema = Schema.Union([
	Schema.Tuple([Schema.Literal('ok'), Schema.String]),
	Schema.Tuple([Schema.Literal('refused'), Schema.String, Schema.NullOr(Schema.String), Schema.NullOr(Schema.Int), Schema.String]),
	Schema.Tuple([Schema.Literal('missing'), Schema.String]),
	Schema.Tuple([Schema.Literal('error'), Schema.String, Schema.String, Schema.String]),
	Schema.Tuple([Schema.Literal('error'), Schema.String, Schema.String, Schema.String, Schema.String])
]);
/** A guest invocation's end state as the prelude reports it (`GuestFinalSchema`). */
export type GuestFinal = typeof GuestFinalSchema.Type;
/** The prelude's `take()`: end state, the calls crossing now, each call's bytes (`$bin`), and whether a timer ran instead. */
export const GuestTaken = Schema.Tuple([
	Schema.NullOr(GuestFinalSchema),
	Schema.Array(Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.Number])),
	Schema.Array(Schema.Array(Schema.Uint8Array)),
	Schema.Boolean
]);
export type GuestTaken = typeof GuestTaken.Type;
/** Schema of one guest turn: what the prelude's `take()` answered, the log lines it wrote and how many it dropped. */
export const GuestTurnSchema = Schema.Struct({
	taken: GuestTaken,
	lines: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
	dropped: Schema.Number
});
/** One guest turn (`GuestTurnSchema`). */
export type GuestTurn = typeof GuestTurnSchema.Type;
/** A compiled guest bundle the runner loads: its JavaScript source, optional source map and embedded assets. */
export type GuestProgram = {
	source: string;
	source_map?: string;
	assets?: Readonly<Record<string, Uint8Array>>;
};
/** A guest session's options: the prelude it evaluates first (the release's `PRELUDE`), its entropy and its heap. */
export type GuestSessionOptions = {
	readonly prelude: string;
	/** `$1` draws SHA-256 blocks of it (`random_stream`), so a replay with the same seed draws the same values. */
	readonly seed: string;
	readonly memory_mib: number;
	/** A program run once (a `run_js` script): no spare isolates are prepared for it. */
	readonly once?: true;
};
/** The prelude's `start(kind, path, inputJson, ctxJson, invocationId)`, by name; `kind` is the release's invocation kind. */
export type GuestStart = {
	readonly kind: string;
	readonly path: readonly string[];
	readonly input: string;
	readonly ctx: string;
	readonly invocation: string;
};
/** One queued ctx call: member, JSON arguments, call site (stack frame) and call id. */
export type GuestCall = readonly [member: string, args: string, site: string, id: number];
/** One batch's answers (`give`): call ids, one JSON text per call, and each call's bytes. */
export type GuestAnswers = {
	readonly ids: readonly number[];
	readonly texts: readonly string[];
	readonly bins: readonly (readonly Uint8Array[])[];
};
/**
 * Guest isolates, made and metered by the host. `open` evaluates `prelude` as an `evalClosure` body with the hooks
 * `$0` say (lines buffered for the turn), `$1` random (from `seed`), `$2` digest (`crypto.subtle.digest`'s host half)
 * and `$3` asset (`program.assets` by sha256), then `program.source` as one module bound to `__boltGuest`; it answers
 * an opaque session id. `start` and `give` run their prelude hook and then `take()`, `take` only `take()` (after a turn
 * whose timer ran): each call is one native slice, under a CPU slot the host takes for it. A session past its unit's
 * CPU budget or its memory ends and rejects with an encoded `HostFailure` of code `cpu_budget` or `memory`; an aborted
 * call ends its session. `close` disposes it (idempotent).
 */
export interface GuestIsolatesPort {
	open(program: GuestProgram, options: GuestSessionOptions, signal: AbortSignal): Promise<string>;
	start(session: string, start: GuestStart, signal: AbortSignal): Promise<GuestTurn>;
	take(session: string, signal: AbortSignal): Promise<GuestTurn>;
	give(session: string, answers: GuestAnswers, signal: AbortSignal): Promise<GuestTurn>;
	close(session: string): Promise<void>;
}
