// Portable failure codes and schemas shared by native engine and protocol consumers.
import { Schema } from 'effect';
import type { StoreError } from '@norbital-ai/store';

export const PHASES = [
	'decode',
	'admission',
	'guest',
	'derive',
	'commit',
	'facility',
	'deliver'
] as const;
export type Phase = (typeof PHASES)[number];
/** What a failure says when its message is not usable text. */
const PHASE_SENTENCE: { readonly [P in Phase]: string } = {
	decode: 'The input could not be decoded.',
	admission: 'The request was not admitted.',
	guest: 'Workspace code failed.',
	derive: 'Deriving the write failed.',
	commit: 'The commit failed.',
	facility: 'A facility call failed.',
	deliver: 'Delivery failed.'
};

/**
 * Every code a `BoltError` carries: the engine's and its hosts' own, the facility error kinds, the outcome kinds and
 * refusal codes a failure re-throws (`'refused' | PlatformRefusal`), and the identity refusals.
 */
export const CODES = [
	'active',
	'approval_split',
	'artifact_digest',
	'bad_answer',
	'bad_cursor',
	'behind',
	'bug',
	'build_failed',
	'busy',
	'check',
	'conflict',
	'conflicts',
	'contract',
	'corrupt',
	'cpu_budget',
	'crossing_budget',
	'destructive_not_accepted',
	'expired',
	'fenced',
	'files',
	'forbidden',
	'guest_error',
	'guest_refused',
	'internal',
	'interrupted',
	'invalid',
	'invalid_code',
	'invalid_cron',
	'invalid_input',
	'invalid_records',
	'invalid_spec',
	'invalid_where',
	'key_reuse',
	'last_admin',
	'locked',
	'memory',
	'migration_changed',
	'migration_invalid',
	'missing_body',
	'missing_ref',
	'needs_sql',
	'no_approval',
	'no_bridge',
	'no_guest',
	'no_progress',
	'no_trigger',
	'not_approved',
	'not_found',
	'not_member',
	'not_ready',
	'overflow',
	'overlap',
	'pending_approval',
	'prepared_computed',
	'prepared_conflict',
	'prepared_ownership',
	'prepared_path',
	'prepared_previous',
	'prepared_read',
	'prepared_upsert',
	'prepared_values',
	'rate_limited',
	'read_budget_exceeded',
	'refused',
	'release_changed',
	'required',
	'restricted',
	'schema',
	'schema_invalid',
	'schema_mismatch',
	'schema_moved',
	'sealed',
	'seed_drift',
	'seed_decode',
	'seed_refused',
	'source_changed',
	'stale',
	'stalled',
	'timeout',
	'too_large',
	'too_many_subscriptions',
	'transform_identity',
	'transform_payload',
	'transform_shape',
	'unaccepted',
	'unavailable',
	'unique',
	'unknown',
	'unknown_automation',
	'unknown_callable',
	'unknown_model',
	'unknown_envoy',
	'unknown_pipeline',
	'unsupported',
	'upload',
	'upstream'
] as const;
export type Code = (typeof CODES)[number];

const fault = (status: number) => ({ status, transient: false });
/** Rule 54: a run retries only these — a facility `upstream`/`timeout`/`rate_limited` or an act `conflict`. */
const retry = (status: number) => ({ status, transient: true });
const CodeInfo = Schema.Struct({ status: Schema.Int, transient: Schema.Boolean });
/** Only exceptions to the default non-transient 500 are listed. */
const overrides: Partial<Record<Code, typeof CodeInfo.Type>> = {
	active: fault(409),
	bad_cursor: fault(400),
	behind: fault(409),
	build_failed: fault(422),
	check: fault(422),
	conflict: retry(409),
	conflicts: fault(409),
	expired: fault(410),
	forbidden: fault(403),
	invalid: fault(400),
	invalid_code: fault(400),
	invalid_input: fault(400),
	last_admin: fault(409),
	not_approved: fault(409),
	not_found: fault(404),
	not_member: fault(403),
	not_ready: fault(409),
	rate_limited: retry(429),
	refused: fault(422),
	stale: fault(409),
	timeout: retry(504),
	too_large: fault(413),
	too_many_subscriptions: fault(429),
	unaccepted: fault(409),
	unavailable: fault(503),
	unknown_callable: fault(404),
	unknown_model: fault(404),
	unsupported: fault(501),
	upstream: retry(502)
};
/** Every declared code has metadata; the sparse table supplies exceptions to the default fault. */
export const CODE = Schema.decodeUnknownSync(Schema.Record(Schema.Literals(CODES), CodeInfo))(
	Object.fromEntries(CODES.map((code) => [code, overrides[code] ?? fault(500)]))
);

const BoltErrorFields = {
	code: Schema.Literals(CODES),
	phase: Schema.Literals(PHASES),
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect())
};
type BoltErrorProps = Schema.Struct.MakeIn<typeof BoltErrorFields>;
type BoltErrorArgs =
	| [code: Code, phase: Phase, message: unknown, cause?: unknown]
	| [props: BoltErrorProps, options?: Schema.MakeOptions];
/** Every engine failure without a tag of its own. */
export class BoltError extends Schema.TaggedError<BoltError>()('BoltError', BoltErrorFields) {
	/** Never throws: a message that is not text (or is blank) becomes the phase's sentence, so `cause` survives. */
	static override make(
		...args: [code: Code, phase: Phase, message: unknown, cause?: unknown]
	): BoltError;
	/** The Schema class's own form (`new BoltError(props)`), which the static side keeps. */
	static override make(...args: [props: BoltErrorProps, options?: Schema.MakeOptions]): BoltError;
	static override make(...args: BoltErrorArgs): BoltError {
		if (isProps(args)) return new BoltError(args[0], args[1]);
		const [code, phase, message, cause] = args;
		return new BoltError({
			code,
			phase,
			message:
				typeof message === 'string' && message.trim() !== '' ? message : PHASE_SENTENCE[phase],
			...(cause === undefined ? {} : { cause })
		});
	}
}
/** A store refusal (`@norbital-ai/store`) as Bolt's: the same code, phase and message. */
export const from_store = (e: StoreError): BoltError =>
	BoltError.make(e.code, e.phase, e.message, e.cause);
const isProps = (
	args: BoltErrorArgs
): args is [props: BoltErrorProps, options?: Schema.MakeOptions] => typeof args[0] !== 'string';
