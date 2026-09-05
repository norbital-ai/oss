import { Duration, Effect } from 'effect';

/** Wall the composer will wait for admit before painting sendFailure. */
export const COMPOSER_COMMAND_DEADLINE_MILLIS = 5_000;

/** Effect duration for the same wall. */
export const COMPOSER_COMMAND_DEADLINE = '5 seconds' as const satisfies Duration.Input;

/** Operator-visible sentence when admit does not return before the wall. */
export const COMPOSER_ADMISSION_TIMEOUT_MESSAGE = 'The Task did not admit within 5 seconds.';

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
 * `tasks.submit` cannot leave the pending You bubble up forever.
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
