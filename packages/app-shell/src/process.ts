import { Console, Duration, Effect, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';

/** A toolchain step, credential or store request that did not complete. */
export class AppShellFailure extends Schema.TaggedError<AppShellFailure>()('AppShellFailure', {
	message: Schema.String
}) {}

const describe = (command: string, args: ReadonlyArray<string>) => [command, ...args].join(' ');

/**
 * Run a toolchain command with its output streamed to this terminal, bounded by `timeout`. Interruption (Ctrl-C,
 * the timeout) kills the child before the scope closes.
 */
export const stream = Effect.fn('AppShell.stream')(function* (
	command: string,
	args: ReadonlyArray<string>,
	options: { readonly cwd: string; readonly timeout: Duration.Input }
) {
	yield* Console.log(`$ ${describe(command, args)}`);
	const code = yield* Effect.scoped(
		Effect.flatMap(
			ChildProcess.make(command, args, {
				cwd: options.cwd,
				stdin: 'inherit',
				stdout: 'inherit',
				stderr: 'inherit'
			}),
			(child) => child.exitCode
		)
	).pipe(
		Effect.timeoutOrElse({
			duration: options.timeout,
			orElse: () =>
				Effect.fail(
					new AppShellFailure({
						message: `${describe(command, args)} exceeded ${Duration.format(Duration.fromInputUnsafe(options.timeout))}`
					})
				)
		}),
		Effect.mapError((error) =>
			error instanceof AppShellFailure
				? error
				: new AppShellFailure({ message: `${command} could not start: ${error.message}` })
		)
	);
	if (code !== 0)
		return yield* new AppShellFailure({ message: `${describe(command, args)} exited ${code}` });
});

/** Run a short probe and return its combined output, or `undefined` when it is missing or fails. */
export const probe = (command: string, args: ReadonlyArray<string>, cwd: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const child = yield* ChildProcess.make(command, args, { cwd });
			const [output, code] = yield* Effect.all(
				[Stream.mkString(Stream.decodeText(child.all)), child.exitCode],
				{ concurrency: 2 }
			);
			return code === 0 ? output.trim() : undefined;
		})
	).pipe(
		Effect.timeoutOrElse({ duration: '30 seconds', orElse: () => Effect.succeed(undefined) }),
		Effect.catch(() => Effect.succeed(undefined))
	);
