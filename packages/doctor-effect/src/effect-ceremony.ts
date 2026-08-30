/**
 * Effect used as ceremony rather than for what Effect is for.
 *
 * This pack comes from reviewing one component that wrapped `JSON.stringify` in `Effect.runSync`
 * and called `void Effect.runPromise(...)` from a template expression. The proposed remedy was to
 * delete Effect from the component and use `async`/`await` with `try`/`catch` — which trades one
 * violation for two, since native control flow in an Effect-owned module is exactly what `EFF1` and
 * `EFF3` exist to prevent.
 *
 * The real defect is narrower and worth naming precisely: **the runtime escape hatch is being used
 * as the API**. `runSync` and `runPromise` exist to run an Effect at the edge of the world. A
 * component that calls them is standing at that edge in the middle of a render, and the ceremony
 * around it — wrapping total functions, materialising `Result` for values that cannot fail — is the
 * visible symptom.
 *
 * The repair is not less Effect. It is invoking the generated mutation, which already owns the
 * lifecycle, and rendering the state it exposes.
 *
 * Every rule here is a *described* shape rather than a hand-written visitor, and carries the source
 * that must match and the source that must not. The examples run in the test suite, so a rule that
 * stops matching, or starts matching a legitimate spelling, fails immediately.
 */
import { defineRule, type ShapeRule } from '@norbital-ai/doctor';
import { definePack, type Rule } from '@norbital-ai/doctor';

/** `Effect.runSync(Effect.sync(() => …))` — a runtime started to run a total function. */
const totalWrap: ShapeRule = {
	id: 'CEREMONY1',
	severity: 'error',
	summary: 'an Effect runtime is started to evaluate a total synchronous expression',
	principles: ['simplicity', 'straightforwardness', 'no-bloat'],
	rule: {
		any: [
			'Effect.runSync(Effect.sync(() => $BODY))',
			'Effect.runSync(Effect.succeed($BODY))',
			'Effect.runSync(Effect.try(() => $BODY))',
			'Effect.runSync(Effect.try({ try: () => $BODY, catch: $CATCH }))'
		]
	},
	examples: {
		bad: [
			'const text = Effect.runSync(Effect.sync(() => JSON.stringify(value, null, 2)));',
			'const n = Effect.runSync(Effect.succeed(count + 1));'
		],
		good: [
			'const text = JSON.stringify(value, null, 2);',
			// Running a real workflow at the edge is what runSync is for.
			'const result = Effect.runSync(program);',
			'const decoded = Effect.runSync(Schema.decodeUnknownEffect(Row)(input));'
		]
	}
};

/** `void Effect.runPromise(...)` — an Effect started and its outcome discarded. */
const discardedRun: ShapeRule = {
	id: 'CEREMONY2',
	severity: 'error',
	summary: 'an Effect is run for its side effect and its failure channel discarded',
	principles: ['straightforwardness', 'testability'],
	// The piped forms are exclusions, not alternatives: an Effect that pipes into a handler has
	// dealt with its failure channel. Folding them into the `any` inverted the rule outright.
	rule: {
		all: [
			'void Effect.runPromise($EFFECT)',
			{
				not: {
					any: [
						'void Effect.runPromise($E.pipe($...REST))',
						'void Effect.runPromise(Effect.tryPromise($ARG).pipe($...REST))'
					]
				}
			}
		]
	},
	examples: {
		bad: ['void Effect.runPromise(save(record));'],
		good: [
			'void Effect.runPromise(save(record).pipe(Effect.catch(report)));',
			'Effect.runFork(program.pipe(Effect.catch((error) => Effect.sync(() => fail(error)))));',
			'await Effect.runPromise(save(record));'
		]
	}
};

/**
 * A component running an Effect *synchronously*, during render.
 *
 * Measured before narrowing: matching every `run*` call in a component produced 60+ findings,
 * because `Effect.runFork(handler)` in an event handler is this codebase's idiom and an event
 * handler genuinely is an edge. A rule that condemns the established idiom is one nobody keeps.
 *
 * `runSync` is different: it blocks, it cannot await, and in a component it runs while the frame is
 * being produced — which is why the cases it finds are formatting helpers that never needed a
 * runtime at all.
 */
const runtimeInComponent: ShapeRule = {
	id: 'CEREMONY3',
	severity: 'error',
	summary: 'a component runs an Effect synchronously during render',
	principles: ['straightforwardness', 'modularity', 'testability'],
	rule: 'Effect.runSync($EFFECT)',
	files: ['**/*.svelte'],
	examples: {
		bad: ['const value = Effect.runSync(program);'],
		good: [
			'Effect.runFork(save(record).pipe(Effect.catch(report)));',
			'const saved = client.db.things.create(input);',
			'const rows = query.current ?? [];'
		]
	}
};

/** `Result.succeed`/`Result.fail` built for a value that has no failure mode. */
const pointlessResult: ShapeRule = {
	id: 'CEREMONY4',
	severity: 'error',
	summary: 'a Result is constructed for a value that cannot fail',
	principles: ['simplicity', 'no-bloat'],
	rule: {
		any: ['Result.succeed($VALUE).pipe($...REST)', 'Effect.runSync(Effect.succeed($VALUE))']
	},
	examples: {
		bad: ['const r = Result.succeed(value).pipe(Result.getOrElse(() => fallback));'],
		good: ['const r = Result.succeed(value);', 'const parsed = decode(input);']
	}
};

/**
 * The same collection filtered twice with a predicate and its negation.
 *
 * Two passes where one would do, and the two halves can drift apart. Effect's `Array.partition`
 * is the one-pass form; so is a single reduce. This is here because the review that prompted the
 * pack proposed replacing a partition *with* two filters, which is the wrong direction.
 */
const doubleFilter: ShapeRule = {
	id: 'CEREMONY5',
	severity: 'error',
	summary: 'one collection is filtered twice where a single partition would do',
	principles: ['simplicity', 'efficiency', 'no-bloat'],
	rule: '$SOURCE.filter($PREDICATE).concat($SOURCE.filter($OTHER))',
	examples: {
		bad: ['const all = fields.filter(isSystem).concat(fields.filter(isNotSystem));'],
		good: ['const [system, rest] = Array.partition(fields, isSystem);']
	}
};

/** The descriptions, so the test suite can run each rule's own examples against it. */
export const effectCeremonyPatterns: ReadonlyArray<ShapeRule> = [
	totalWrap,
	discardedRun,
	runtimeInComponent,
	pointlessResult,
	doubleFilter
];

export const effectCeremonyPack = definePack({
	name: 'norbital/effect-ceremony',
	rules: effectCeremonyPatterns.map(defineRule) as ReadonlyArray<Rule>
});
