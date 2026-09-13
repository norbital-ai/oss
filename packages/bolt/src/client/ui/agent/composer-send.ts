import { Duration, Effect } from 'effect';

/** Wall the composer will wait for admit before painting sendFailure. */
/**
 * How long the composer waits for a send, which is now a whole turn.
 *
 * Five seconds, when `conversations.send` only admitted a message and a separate durable
 * occurrence ran the turn. It admits *and answers* in one invocation now, so the response does not
 * arrive until the model has finished — and a five-second wall aborted the request mid-turn on
 * every real reply, painting a failure over a conversation that was still running.
 *
 * The wall is not what tells the operator their message landed: the pending bubble is cleared when
 * the durable row arrives over live sync, independently of this response (`visibleUnsettledAdmission`).
 * This bounds the browser wait only. The host runs detached from that wait and may continue
 * overnight. The panel suppresses this timeout while durable task state still reports running.
 */
export const COMPOSER_COMMAND_DEADLINE_MILLIS = 1_800_000;

/** Effect duration for the same wall. */
export const COMPOSER_COMMAND_DEADLINE = '1800 seconds' as const satisfies Duration.Input;

/** Operator-visible sentence when the send does not return before the wall. */
export const COMPOSER_ADMISSION_TIMEOUT_MESSAGE =
	'The agent did not answer within 30 minutes. Your message was saved; reopen the conversation to see the reply.';

type ComposerSendHandlers<A> = Readonly<{
	readonly onSuccess: (result: A) => void;
	readonly onFailure: (message: string) => void;
	readonly onSettled: () => void;
}>;

/**
 * One composer command: success clears the draft, a typed failure paints sendFailure,
 * and `ensuring` always re-enables the composer. A defect still skips tap/tapError.
 *
 * The command is interrupted at {@link COMPOSER_COMMAND_DEADLINE} so a hung encode or
 * `conversations.send` cannot leave the pending You bubble up forever.
 */
export function runComposerCommand<A, E extends { readonly message: string }>(
	command: Effect.Effect<A, E>,
	handlers: ComposerSendHandlers<A>,
	deadline: Duration.Input = COMPOSER_COMMAND_DEADLINE
): Effect.Effect<void, E | Error> {
	return command.pipe(
		Effect.timeoutOrElse({
			duration: deadline,
			orElse: () => Effect.fail(new Error(COMPOSER_ADMISSION_TIMEOUT_MESSAGE))
		}),
		Effect.tap((result) => Effect.sync(() => handlers.onSuccess(result))),
		Effect.tapError((error) => Effect.sync(() => handlers.onFailure(error.message))),
		Effect.ensuring(Effect.sync(() => handlers.onSettled())),
		Effect.asVoid
	);
}
