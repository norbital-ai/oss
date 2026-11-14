// Durable waits (`ctx.wait`). A run that waits ends its attempt and holds no lane: its row is `waiting`, `due_at` its
// deadline (`infinity` without one), and `wait` keeps what it waits on, the run's clock and the answer of every crossing
// it made so far, in order. The wait is registered on the running row first, so a write or decision that commits
// while the attempt ends is kept. Its deadline (the claim), a committed write to the waited model (`wakeWrites`) or
// the waited approval's decision (`wakeApproval`) queues it again. The next attempt runs the body from the start with the
// same clock and random seed, answering each crossing from the journal (a crossing that differs fails the run) until
// the wait, which answers what woke it. Nothing runs, and nothing reads the tenant database, while a run waits.
import { Option, Schema } from 'effect';
import { sha256_hex } from '@norbital-ai/store';
import { MessageValues } from '../../decl/errors/refusal.ts';
import { FACILITY_KINDS } from '@norbital-ai/host-api';
import type { Json } from '../../decl/values.ts';
import { LIMITS, utf8Bytes, type CrossAnswer } from '../contracts.ts';
import { fromBase64, toBase64 } from '../crypto.ts';
import type { CrossCall } from '../services.ts';

const Verbs = Schema.NonEmptyArray(Schema.Literals(['create', 'update', 'delete']));
/** What `ctx.wait` waits on: an approval's decision, a write to a model matching `where`, or only its deadline `until`. */
export const WaitOn = Schema.Union([
	Schema.Struct({ approval: Schema.String, until: Schema.optionalKey(Schema.String) }),
	Schema.Struct({
		model: Schema.String,
		where: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
		verbs: Schema.optionalKey(Verbs),
		until: Schema.optionalKey(Schema.String)
	}),
	Schema.Struct({ until: Schema.String })
]);
export type WaitOn = typeof WaitOn.Type;
/** What woke a waiting run besides its deadline; `wakeWrites` and `wakeApproval` write it. */
export const Woke = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('event'), model: Schema.String, records: Schema.Array(Schema.String) }),
	Schema.Struct({ kind: Schema.Literal('approval'), request: Schema.String, state: Schema.String })
]);
/** One crossing's answer: `d` the call's digest, `a` the answer as JSON text, `b` its bytes in base64. */
const Entry = Schema.Struct({ d: Schema.String, a: Schema.String, b: Schema.optionalKey(Schema.Array(Schema.String)) });
export const WaitState = Schema.Struct({
	on: WaitOn,
	/** The run's clock, kept for every attempt after its first wait. */
	now: Schema.String,
	journal: Schema.Array(Entry),
	woke: Schema.optionalKey(Woke)
});
/** A wait as the running row registers it before it checks anything: a wake from then on is kept for it. */
export const Registered = Schema.Struct({ on: WaitOn, woke: Schema.optionalKey(Woke) });
export type WaitState = typeof WaitState.Type;
type Journal = typeof WaitState.Type['journal'][number];

const Failure = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('unavailable'), facility: Schema.String, reason: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal('refused'),
		code: Schema.String,
		message: Schema.String,
		key: Schema.optionalKey(Schema.String),
		values: Schema.optionalKey(MessageValues),
		field: Schema.optionalKey(Schema.String),
		row: Schema.optionalKey(Schema.Number),
		rows: Schema.optionalKey(Schema.Array(Schema.Number)),
		rule: Schema.optionalKey(Schema.String)
	}),
	Schema.Struct({ kind: Schema.Literal('bolt'), code: Schema.String, message: Schema.String }),
	Schema.Struct({ kind: Schema.Literals(FACILITY_KINDS), message: Schema.String, status: Schema.optional(Schema.Number) })
]);
const Answer = Schema.fromJsonString(
	Schema.Union([
		Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
		Schema.Struct({ ok: Schema.Literal(false), error: Failure })
	])
);
const encodeAnswer = Schema.encodeSync(Answer),
	decodeAnswer = Schema.decodeUnknownOption(Answer);

/** A crossing's identity in the journal: its member and arguments, its bytes by length. */
const digest = (call: CrossCall): string =>
	sha256_hex(JSON.stringify(call, (_, v: unknown) => (v instanceof Uint8Array ? v.byteLength : v)));
export const journalEntry = (call: CrossCall, answer: CrossAnswer): Journal => {
	const bins = answer.ok ? answer.bins : undefined;
	return {
		d: digest(call),
		a: encodeAnswer(answer.ok ? { ok: true, value: answer.value } : answer),
		...(bins === undefined ? {} : { b: bins.map(toBase64) })
	};
};
/**
 * The journal's answer to `call`, the `at`-th crossing of the attempt: `undefined` past the journal's end; `diverged`
 * when the body made another crossing there (its code or input changed since it waited).
 */
export const replayed = (journal: readonly Journal[], at: number, call: CrossCall): CrossAnswer | 'diverged' | undefined => {
	const entry = journal[at];
	if (entry === undefined) return undefined;
	if (entry.d !== digest(call)) return 'diverged';
	return Option.match(decodeAnswer(entry.a), {
		onNone: () => 'diverged' as const,
		onSome: (answer): CrossAnswer =>
			answer.ok && entry.b !== undefined ? { ...answer, bins: entry.b.map(fromBase64) } : answer
	});
};
/** The journal fits a run row: a wait past it is refused, not stored. */
export const journalFits = (state: WaitState): boolean =>
	utf8Bytes(JSON.stringify(state)) <= LIMITS.waitBytes;
/** The run's wait as the row stores it (`sys_run.wait`). */
export const waitJson = (state: WaitState): Json => Schema.encodeSync(WaitState)(state);
