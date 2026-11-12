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
/** Every declared code's HTTP status and whether a run retries it. */
export const CODE = {
	active: fault(409),
	approval_split: fault(500),
	artifact_digest: fault(500),
	bad_answer: fault(500),
	bad_cursor: fault(400),
	behind: fault(409),
	bug: fault(500),
	build_failed: fault(422),
	busy: fault(500),
	check: fault(422),
	conflict: retry(409),
	conflicts: fault(409),
	contract: fault(500),
	corrupt: fault(500),
	cpu_budget: fault(500),
	crossing_budget: fault(500),
	destructive_not_accepted: fault(500),
	expired: fault(410),
	fenced: fault(500),
	files: fault(500),
	forbidden: fault(403),
	guest_error: fault(500),
	guest_refused: fault(500),
	internal: fault(500),
	interrupted: fault(500),
	invalid: fault(400),
	invalid_code: fault(400),
	invalid_cron: fault(500),
	invalid_input: fault(400),
	invalid_records: fault(500),
	invalid_spec: fault(500),
	invalid_where: fault(500),
	key_reuse: fault(500),
	last_admin: fault(409),
	locked: fault(500),
	memory: fault(500),
	migration_changed: fault(500),
	migration_invalid: fault(500),
	missing_body: fault(500),
	missing_ref: fault(500),
	needs_sql: fault(500),
	no_approval: fault(500),
	no_bridge: fault(500),
	no_guest: fault(500),
	no_progress: fault(500),
	no_trigger: fault(500),
	not_approved: fault(409),
	not_found: fault(404),
	not_member: fault(403),
	not_ready: fault(409),
	overflow: fault(500),
	overlap: fault(500),
	pending_approval: fault(500),
	prepared_computed: fault(500),
	prepared_conflict: fault(500),
	prepared_ownership: fault(500),
	prepared_path: fault(500),
	prepared_previous: fault(500),
	prepared_read: fault(500),
	prepared_upsert: fault(500),
	prepared_values: fault(500),
	rate_limited: retry(429),
	read_budget_exceeded: fault(500),
	refused: fault(422),
	release_changed: fault(500),
	required: fault(500),
	restricted: fault(500),
	schema: fault(500),
	schema_invalid: fault(500),
	schema_mismatch: fault(500),
	schema_moved: fault(500),
	sealed: fault(500),
	seed_drift: fault(500),
	seed_decode: fault(500),
	seed_refused: fault(500),
	source_changed: fault(500),
	stale: fault(409),
	stalled: fault(500),
	timeout: retry(504),
	too_large: fault(413),
	too_many_subscriptions: fault(429),
	transform_identity: fault(500),
	transform_payload: fault(500),
	transform_shape: fault(500),
	unaccepted: fault(409),
	unavailable: fault(503),
	unique: fault(500),
	unknown: fault(500),
	unknown_automation: fault(500),
	unknown_callable: fault(404),
	unknown_model: fault(404),
	unknown_envoy: fault(500),
	unknown_pipeline: fault(500),
	unsupported: fault(501),
	upload: fault(500),
	upstream: retry(502)
} satisfies { readonly [C in Code]: { readonly status: number; readonly transient: boolean } };

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
