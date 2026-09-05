import { Option, Schema } from 'effect';

/** Long-running Studio jobs that must push status; they must never be polled. */
const AuthoringLiveJob = Schema.Literals(['diagnose', 'preview', 'publish', 'merge', 'deploy']);
type AuthoringLiveJob = typeof AuthoringLiveJob.Type;

const AuthoringLivePhase = Schema.Literals([
	'prepare',
	'checks',
	'publish',
	'provision',
	'complete'
]);
type AuthoringLivePhase = typeof AuthoringLivePhase.Type;

const AuthoringLiveLogStream = Schema.Literals(['build', 'deploy', 'guest']);
type AuthoringLiveLogStream = typeof AuthoringLiveLogStream.Type;

export const AUTHORING_LOG_LINE_MAX_CHARS = 800;
export const AUTHORING_LOG_RING = 256;

export const AuthoringLiveEvent = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal('source'),
		tenantId: Schema.NonEmptyString,
		workspaceKey: Schema.NonEmptyString,
		commit: Schema.NonEmptyString,
		at: Schema.NonEmptyString
	}),
	Schema.Struct({
		kind: Schema.Literal('phase'),
		tenantId: Schema.NonEmptyString,
		job: AuthoringLiveJob,
		phase: AuthoringLivePhase,
		at: Schema.NonEmptyString
	}),
	Schema.Struct({
		kind: Schema.Literal('log'),
		tenantId: Schema.NonEmptyString,
		job: AuthoringLiveJob,
		stream: AuthoringLiveLogStream,
		level: Schema.NonEmptyString,
		line: Schema.String,
		at: Schema.NonEmptyString
	}),
	Schema.Struct({
		kind: Schema.Literal('memory'),
		tenantId: Schema.NonEmptyString,
		workspaceKey: Schema.NonEmptyString,
		rssMiB: Schema.Number,
		limitMiB: Schema.Number,
		at: Schema.NonEmptyString
	}),
	Schema.Struct({
		kind: Schema.Literal('comment'),
		tenantId: Schema.NonEmptyString,
		requestId: Schema.NonEmptyString,
		by: Schema.NonEmptyString,
		body: Schema.NonEmptyString,
		at: Schema.NonEmptyString
	}),
	Schema.Struct({
		kind: Schema.Literal('decision'),
		tenantId: Schema.NonEmptyString,
		requestId: Schema.NonEmptyString,
		decision: Schema.Literals(['approved', 'changes_requested', 'rejected']),
		by: Schema.NonEmptyString,
		at: Schema.NonEmptyString
	})
]);
export type AuthoringLiveEvent = typeof AuthoringLiveEvent.Type;

export type AuthoringLiveState = Readonly<{
	readonly job: null | Readonly<{
		readonly action: AuthoringLiveJob;
		readonly phase: AuthoringLivePhase;
		readonly at: string;
	}>;
	readonly logs: ReadonlyArray<
		Readonly<{
			readonly job: AuthoringLiveJob;
			readonly stream: AuthoringLiveLogStream;
			readonly level: string;
			readonly line: string;
			readonly at: string;
		}>
	>;
	readonly memory: null | Readonly<{
		readonly workspaceKey: string;
		readonly rssMiB: number;
		readonly limitMiB: number;
		readonly at: string;
	}>;
	readonly comments: ReadonlyArray<
		Readonly<{
			readonly requestId: string;
			readonly by: string;
			readonly body: string;
			readonly at: string;
		}>
	>;
	readonly decisions: ReadonlyArray<
		Readonly<{
			readonly requestId: string;
			readonly decision: 'approved' | 'changes_requested' | 'rejected';
			readonly by: string;
			readonly at: string;
		}>
	>;
}>;

export const emptyAuthoringLiveState = (): AuthoringLiveState => ({
	job: null,
	logs: [],
	memory: null,
	comments: [],
	decisions: []
});

export const clipAuthoringLogLine = (line: string): string =>
	line.length <= AUTHORING_LOG_LINE_MAX_CHARS ? line : line.slice(0, AUTHORING_LOG_LINE_MAX_CHARS);

/**
 * Fold one pushed frame into Studio chrome. Snapshot `read()` is the initial document only;
 * later progress is this fold. A timer that re-reads the host snapshot is a poll and is refused.
 */
export const applyAuthoringLiveEvent = (
	state: AuthoringLiveState,
	event: AuthoringLiveEvent
): AuthoringLiveState => {
	switch (event.kind) {
		case 'source':
			return state;
		case 'phase':
			return {
				...state,
				job: { action: event.job, phase: event.phase, at: event.at }
			};
		case 'log': {
			const next = [
				...state.logs,
				{
					job: event.job,
					stream: event.stream,
					level: event.level,
					line: clipAuthoringLogLine(event.line),
					at: event.at
				}
			];
			return {
				...state,
				logs:
					next.length <= AUTHORING_LOG_RING ? next : next.slice(next.length - AUTHORING_LOG_RING)
			};
		}
		case 'memory':
			return {
				...state,
				memory: {
					workspaceKey: event.workspaceKey,
					rssMiB: event.rssMiB,
					limitMiB: event.limitMiB,
					at: event.at
				}
			};
		case 'comment':
			return {
				...state,
				comments: [
					...state.comments,
					{
						requestId: event.requestId,
						by: event.by,
						body: event.body,
						at: event.at
					}
				]
			};
		case 'decision':
			return {
				...state,
				decisions: [
					...state.decisions,
					{
						requestId: event.requestId,
						decision: event.decision,
						by: event.by,
						at: event.at
					}
				]
			};
		default: {
			const unhandled: never = event;
			throw new Error(`Unhandled authoring live event: ${JSON.stringify(unhandled)}`);
		}
	}
};

export const diagnosisFindingTone = (
	severity: 'error' | 'warning' | 'hint'
): 'danger' | 'warning' | 'info' => {
	switch (severity) {
		case 'error':
			return 'danger';
		case 'warning':
			return 'warning';
		case 'hint':
			return 'info';
		default: {
			const unhandled: never = severity;
			throw new Error(`Unhandled diagnosis severity: ${String(unhandled)}`);
		}
	}
};

/** Level color for captured build/deploy/guest lines. ANSI is stripped at the host; this is the UI tone. */
export const authoringLogTone = (level: string): 'danger' | 'warning' | 'info' | 'default' => {
	switch (level) {
		case 'error':
		case 'stderr':
			return 'danger';
		case 'warning':
		case 'warn':
			return 'warning';
		case 'hint':
		case 'info':
			return 'info';
		default:
			return 'default';
	}
};

export const authoringJobBusy = (state: AuthoringLiveState): boolean =>
	state.job !== null && state.job.phase !== 'complete';

export const authoringLiveJobMessageKey = (job: AuthoringLiveJob) => {
	switch (job) {
		case 'diagnose':
			return 'bolt.studio.live.job.diagnose';
		case 'preview':
			return 'bolt.studio.live.job.preview';
		case 'publish':
			return 'bolt.studio.live.job.publish';
		case 'merge':
			return 'bolt.studio.live.job.merge';
		case 'deploy':
			return 'bolt.studio.live.job.deploy';
		default: {
			const unhandled: never = job;
			throw new Error(`Unhandled authoring live job: ${String(unhandled)}`);
		}
	}
};

export const authoringLivePhaseMessageKey = (phase: AuthoringLivePhase) => {
	switch (phase) {
		case 'prepare':
			return 'bolt.studio.phase.prepare';
		case 'checks':
			return 'bolt.studio.phase.checks';
		case 'publish':
			return 'bolt.studio.phase.publish';
		case 'provision':
			return 'bolt.studio.phase.provision';
		case 'complete':
			return 'bolt.studio.phase.complete';
		default: {
			const unhandled: never = phase;
			throw new Error(`Unhandled authoring live phase: ${String(unhandled)}`);
		}
	}
};

/** Browser EventSource event name; the host encodes `event: authoring` on GET …/authoring/stream. */
export const AUTHORING_LIVE_SSE_EVENT = 'authoring';

export const AUTHORING_LIVE_EVENT_SOURCE_INIT = { withCredentials: true } as const;

export type AuthoringEventSourceInit = typeof AUTHORING_LIVE_EVENT_SOURCE_INIT;

type AuthoringEventSourceLike = {
	addEventListener: (type: string, listener: (event: { data: string }) => void) => void;
	close: () => void;
};

/**
 * Decode one EventSource `data` payload. `kind: poll`, a foreign tenant, or malformed JSON
 * is none — the stream never installs an interval and never re-reads a snapshot.
 */
const decodeAuthoringLiveFrame = (
	data: string,
	tenantId: string
): Option.Option<AuthoringLiveEvent> => {
	// One decode: the JSON text is parsed and validated in a single Schema step, so a malformed
	// frame and a frame that matches no event are the same none.
	const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(AuthoringLiveEvent))(data);
	if (Option.isNone(decoded)) return decoded;
	if (decoded.value.tenantId !== tenantId) return Option.none();
	return decoded;
};

/**
 * One EventSource after subscribe. Frames are pushed; this helper never re-reads a snapshot
 * and never installs an interval.
 */
export const openAuthoringLiveStream = (options: {
	readonly url: string;
	readonly tenantId: string;
	readonly onEvent: (event: AuthoringLiveEvent) => void;
	readonly source?: (url: string, init: AuthoringEventSourceInit) => AuthoringEventSourceLike;
}): (() => void) => {
	const create =
		options.source ??
		((url: string, init: AuthoringEventSourceInit): AuthoringEventSourceLike =>
			new EventSource(url, init));
	const source = create(options.url, AUTHORING_LIVE_EVENT_SOURCE_INIT);
	const onFrame = (message: { data: string }): void => {
		const decoded = decodeAuthoringLiveFrame(message.data, options.tenantId);
		if (Option.isNone(decoded)) return;
		options.onEvent(decoded.value);
	};
	source.addEventListener(AUTHORING_LIVE_SSE_EVENT, onFrame);
	return () => source.close();
};
