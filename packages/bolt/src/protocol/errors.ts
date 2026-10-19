// Portable failure codes and schemas shared by native engine and protocol consumers.
import { Schema } from 'effect';

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
	'approvalSplit',
	'artifactDigest',
	'badAnswer',
	'badCursor',
	'behind',
	'bug',
	'buildFailed',
	'busy',
	'check',
	'conflict',
	'conflicts',
	'contract',
	'corrupt',
	'cpuBudget',
	'crossingBudget',
	'destructiveNotAccepted',
	'expired',
	'fenced',
	'files',
	'forbidden',
	'guestError',
	'guestRefused',
	'internal',
	'interrupted',
	'invalid',
	'invalidCode',
	'invalidCron',
	'invalidInput',
	'invalidRecords',
	'invalidSpec',
	'invalidWhere',
	'keyReuse',
	'lastAdmin',
	'locked',
	'memory',
	'missingBody',
	'missingRef',
	'needsSql',
	'noApproval',
	'noBridge',
	'noGuest',
	'noProgress',
	'noTrigger',
	'notApproved',
	'notFound',
	'notMember',
	'notReady',
	'overflow',
	'overlap',
	'pendingApproval',
	'preparedComputed',
	'preparedConflict',
	'preparedOwnership',
	'preparedPath',
	'preparedPrevious',
	'preparedRead',
	'preparedUpsert',
	'preparedValues',
	'rateLimited',
	'readBudgetExceeded',
	'refused',
	'releaseChanged',
	'required',
	'restricted',
	'schema',
	'schemaInvalid',
	'schemaMismatch',
	'schemaMoved',
	'sealed',
	'SeedDrift',
	'seedDecode',
	'seedRefused',
	'sourceChanged',
	'stale',
	'stalled',
	'timeout',
	'tooLarge',
	'tooManySubscriptions',
	'transformIdentity',
	'transformPayload',
	'transformShape',
	'unaccepted',
	'unavailable',
	'unique',
	'unknown',
	'unknownAutomation',
	'unknownCallable',
	'unknownCollection',
	'unknownEnvoy',
	'unknownPipeline',
	'unsupported',
	'upload',
	'upstream'
] as const;
export type Code = (typeof CODES)[number];

const fault = (status: number) => ({ status, transient: false });
/** Rule 54: a run retries only these — a facility `upstream`/`timeout`/`rateLimited` or an act `conflict`. */
const retry = (status: number) => ({ status, transient: true });
/** Each code's HTTP status (the protocol's and the shell's maps; any other code is 500) and retry class. */
export const CODE = {
	active: fault(409),
	approvalSplit: fault(500),
	artifactDigest: fault(500),
	badAnswer: fault(500),
	badCursor: fault(400),
	behind: fault(409),
	bug: fault(500),
	buildFailed: fault(422),
	busy: fault(500),
	check: fault(422),
	conflict: retry(409),
	conflicts: fault(409),
	contract: fault(500),
	corrupt: fault(500),
	cpuBudget: fault(500),
	crossingBudget: fault(500),
	destructiveNotAccepted: fault(500),
	expired: fault(410),
	fenced: fault(500),
	files: fault(500),
	forbidden: fault(403),
	guestError: fault(500),
	guestRefused: fault(500),
	internal: fault(500),
	interrupted: fault(500),
	invalid: fault(400),
	invalidCode: fault(400),
	invalidCron: fault(500),
	invalidInput: fault(400),
	invalidRecords: fault(500),
	invalidSpec: fault(500),
	invalidWhere: fault(500),
	keyReuse: fault(500),
	lastAdmin: fault(409),
	locked: fault(500),
	memory: fault(500),
	missingBody: fault(500),
	missingRef: fault(500),
	needsSql: fault(500),
	noApproval: fault(500),
	noBridge: fault(500),
	noGuest: fault(500),
	noProgress: fault(500),
	noTrigger: fault(500),
	notApproved: fault(409),
	notFound: fault(404),
	notMember: fault(403),
	notReady: fault(409),
	overflow: fault(500),
	overlap: fault(500),
	pendingApproval: fault(500),
	preparedComputed: fault(500),
	preparedConflict: fault(500),
	preparedOwnership: fault(500),
	preparedPath: fault(500),
	preparedPrevious: fault(500),
	preparedRead: fault(500),
	preparedUpsert: fault(500),
	preparedValues: fault(500),
	rateLimited: retry(429),
	readBudgetExceeded: fault(500),
	refused: fault(422),
	releaseChanged: fault(500),
	required: fault(500),
	restricted: fault(500),
	schema: fault(500),
	schemaInvalid: fault(500),
	schemaMismatch: fault(500),
	schemaMoved: fault(500),
	sealed: fault(500),
	SeedDrift: fault(500),
	seedDecode: fault(500),
	seedRefused: fault(500),
	sourceChanged: fault(500),
	stale: fault(409),
	stalled: fault(500),
	timeout: retry(504),
	tooLarge: fault(413),
	tooManySubscriptions: fault(429),
	transformIdentity: fault(500),
	transformPayload: fault(500),
	transformShape: fault(500),
	unaccepted: fault(409),
	unavailable: fault(503),
	unique: fault(500),
	unknown: fault(500),
	unknownAutomation: fault(500),
	unknownCallable: fault(404),
	unknownCollection: fault(404),
	unknownEnvoy: fault(500),
	unknownPipeline: fault(500),
	unsupported: fault(501),
	upload: fault(500),
	upstream: retry(502)
} as const satisfies {
	readonly [C in Code]: { readonly status: number; readonly transient: boolean };
};

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
const isProps = (
	args: BoltErrorArgs
): args is [props: BoltErrorProps, options?: Schema.MakeOptions] => typeof args[0] !== 'string';
