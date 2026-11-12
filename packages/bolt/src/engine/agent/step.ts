// Shared model-response assembly and ordered call execution; each workflow owns its persistence and stopping rules.
import { Effect, Option } from 'effect';
import { FacilityFailure } from '../../decl/errors.ts';
import type { Json } from '../../decl/values.ts';
import type { AiResponse } from '../contracts.ts';
import { textOf, type AssistantSegment, type ToolCall } from './schema.ts';

export type ModelCarry = {
	readonly text: string;
	readonly reasoning: string;
	readonly segments: readonly AssistantSegment[];
	readonly continuation?: string;
};
export const model_step = Effect.fn('Agent.modelStep')(function* <E, R>(
	work: Effect.Effect<AiResponse, E, R>,
	previous?: ModelCarry
) {
	const response = yield* work;
	const ids = new Set<string>();
	const calls: ToolCall[] = [];
	if (response.finish !== 'cut') for (const call of response.tool_calls) {
		if (call.id === '' || ids.has(call.id))
			return yield* new FacilityFailure({ kind: 'invalid', message: 'The model returned an empty or duplicate tool-call id.' });
		ids.add(call.id);
		calls.push({ id: call.id, name: call.name, input: call.input, ...(call.invalid === undefined ? {} : { invalid: call.invalid }) });
	}
	const text = (previous?.text ?? '') + textOf(response.content);
	const reasoning = (previous?.reasoning ?? '') + (response.reasoning ?? '');
	const segment: AssistantSegment = {
		text: textOf(response.content), toolCalls: calls,
		...(response.reasoning === undefined || response.reasoning === '' ? {} : { reasoning: response.reasoning })
	};
	const carry: ModelCarry = {
		text, reasoning, segments: [...(previous?.segments ?? []), segment],
		...(response.continuation === undefined ? {} : { continuation: response.continuation })
	};
	const content: Json = previous?.text ? text : response.content;
	return { response, text, reasoning, content, calls, segment, carry };
});

/** Ordered execution still visits calls skipped after submission, so their protocol results are recorded. */
export const run_calls = Effect.fn('Agent.runCalls')(function* <A, E, R>(
	calls: readonly ToolCall[],
	run: (call: ToolCall, invalid: { readonly error: string } | undefined, completed: boolean) => Effect.Effect<Option.Option<A>, E, R>
) {
	let done: Option.Option<A> = Option.none();
	for (const call of calls) {
		const invalid = call.invalid === undefined ? undefined : {
			error: `Not run: the arguments were not valid JSON (${call.invalid}). Call ${call.name} again with valid JSON arguments.`
		};
		const next = yield* run(call, invalid, Option.isSome(done));
		if (Option.isNone(done)) done = next;
	}
	return done;
});
