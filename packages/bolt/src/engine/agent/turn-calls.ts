// Step tool-call execution: running/settled rows, replay and repeat-failure skips, confirmation cards, question replies and turn guards.
import { Clock, Effect, Option } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { EngineError } from '../errors.ts';
import type { ToolAnswer } from './ai.ts';
import { bounded, storedToolResult } from './context.ts';
import { isObj } from './draft.ts';
import type { AgentStore } from './messages.ts';
import {
	clip,
	type As,
	type ConversationRow,
	type MessageRow,
	type Meta,
	type ToolCall
} from './schema.ts';
import {
	AGENT_LIMITS,
	callKey,
	failedResult,
	NUDGE,
	stepKey,
	turnGuard,
	type TurnState
} from './shared.ts';
import { run_calls } from './step.ts';
import type { catalogue } from './tools.ts';
import type { TurnIo } from './turn-io.ts';

export type TurnCallsDeps = {
	readonly id: string;
	readonly turn: string;
	readonly store: AgentStore;
	readonly io: TurnIo;
	readonly current: TurnState;
	readonly settle: (id: string) => Effect.Effect<boolean, EngineError>;
};

export const makeExecuteCalls = (deps: TurnCallsDeps) => {
	const { id, turn, store, io, current, settle } = deps;

	return Effect.fn('Agents.calls')(function* (
		conv: ConversationRow,
		sender: As,
		toolset: Effect.Success<ReturnType<typeof catalogue>>,
		tools: readonly { readonly name: string }[],
		row: MessageRow,
		calls: readonly ToolCall[],
		window: number
	) {
		let waiting = false,
			failed = 0;
		yield* run_calls(
			calls,
			Effect.fn('Agents.runCall')(function* (call, invalid) {
				// the call is a `running` row while it runs, finished in place when it answers
				const started = yield* Clock.currentTimeMillis,
					args = clip(call.input, 8000);
				const operation = toolset.presentation(call.name, call.input);
				const role = {
					behavior: operation.behavior,
					...(operation.studio === undefined ? {} : { studio: operation.studio }),
					...(operation.view === undefined ? {} : { view: operation.view }),
					...(operation.name === call.name
						? {}
						: {
								display: { name: operation.name, args: clip(operation.input, 8000) }
							})
				};
				const step = yield* store.insert({
					conversation: id,
					role: 'tool',
					content: { id: call.id, name: call.name, assistant: row.id, args, ...role },
					state: 'running',
					turn
				});
				/** The running row finished in place with the call's answer. */
				const finish = Effect.fnUntraced(function* (
					result?: Json,
					meta: Meta | null = null,
					extra: { state?: 'confirm'; as?: As } = {}
				) {
					const ms = (yield* Clock.currentTimeMillis) - started;
					const content = {
						id: call.id,
						name: call.name,
						...role,
						args,
						...(result === undefined ? {} : { ms, result })
					};
					yield* io.wrote(yield* io.rewrite(step, content, null, meta, extra));
				});
				const tool = tools.find((t) => t.name === call.name),
					key = callKey(call.name, call.input);
				// a call the dead generation made (its result never recorded) is not made again; nor one that already failed
				// this often
				const skipped = current.replayed.delete(stepKey(call.name, args))
					? NUDGE.replayed
					: (current.failures.get(key) ?? 0) >= AGENT_LIMITS.sameFailure
						? 'Not run: this exact call already failed several times this turn.'
						: undefined;
				const skip = tool === undefined || skipped !== undefined;
				const answer: ToolAnswer =
					tool === undefined
						? {
								result: {
									error: toolset.available.some((t) => t.name === call.name)
										? `'${call.name}' runs through run_tool: run_tool { name: '${call.name}', input }.`
										: `No tool '${call.name}'.`
								}
							}
						: invalid !== undefined
							? { result: invalid }
							: skipped !== undefined
								? { result: { error: skipped } }
								: yield* toolset.run(call.name, call.input, call.id);
				// what the call opened goes right after the call's result, on the next request
				for (const file of current.files) file.call ??= call.id;
				if ('confirm' in answer && conv.parent !== null)
					yield* finish({
						error: "This needs the person's confirmation; hand it back to the delegating agent."
					});
				else if ('confirm' in answer) {
					waiting = true;
					yield* finish(
						undefined,
						{
							tag: 'confirm',
							call: answer.input === undefined ? call : { ...call, input: answer.input }
						},
						{ state: 'confirm', as: sender }
					);
				} else {
					const result = answer.result;
					if (failedResult(result)) {
						current.failures.set(key, (current.failures.get(key) ?? 0) + 1);
						failed++;
						if (!skip || current.lastError === '') current.lastError = String(result['error']); // staff see the real failure, not the cut-short
					} else current.failures.clear(); // a call that worked is progress: an earlier failure is worth one fresh try
					// the model sees a bounded result; a clipped one keeps the whole output for `read_output`
					const own = 'bounded' in answer && answer.bounded === true,
						whole = own && answer.full !== undefined ? answer.full : result,
						shown = own ? result : bounded(result).value;
					const stored = storedToolResult(call.id, shown, whole);
					yield* finish(
						stored.result,
						stored.full === undefined ? null : { tag: 'output', full: stored.full }
					);
					// a live approval card (e.g. workspace_merge / workspace_rollback) pauses the main turn until the person decides
					if (
						conv.parent === null &&
						isObj(result) &&
						isObj(result['approval']) &&
						typeof result['approval']['id'] === 'string'
					)
						waiting = true;
				}
				return Option.none();
			})
		);
		if (waiting) {
			current.reply = null;
			return yield* settle(id);
		}
		// Channels receive the same question in plain words; the shell retains its choices as controls.
		if (current.question !== null) {
			const question = current.question;
			const text = [
				question.question,
				...question.options.map((option, index) => `${index + 1}. ${option}`)
			].join('\n\n');
			current.question = null;
			current.reply = yield* io.reply(null, { text, toolCalls: [] }, text, {
				tag: 'reply',
				receipts: [...current.receipts],
				asked: true,
				question,
				usage: { ...current.usage, context: current.lastInput, window, model: conv.model }
			});
			current.receipts.length = 0;
			return yield* settle(id);
		}
		const guard = turnGuard(current, calls.length, failed);
		if (guard !== undefined) {
			yield* io.fail(conv, guard.text, guard.code, current.lastError);
			yield* store.cancelQueued(id);
			return true;
		}
		return false;
	});
};
