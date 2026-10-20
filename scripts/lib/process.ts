import { Effect, Stream } from 'effect';
import { ChildProcess } from 'effect/unstable/process';
import { ProcessEnvironment } from '../runtime.ts';
import { PublicationFailed } from './error.ts';
export const capture = Effect.fn('Publication.capture')(
	(command: string, args: ReadonlyArray<string>, cwd: string) =>
		Effect.scoped(
			Effect.gen(function* () {
				const environment = yield* ProcessEnvironment;
				const child = yield* ChildProcess.make(command, [...args], {
					cwd,
					env: { ...environment },
					extendEnv: false,
					stdin: 'ignore',
					stdout: 'pipe',
					stderr: 'pipe',
					forceKillAfter: 15_000
				});
				const [stdout, stderr, code] = yield* Effect.all(
					[
						Stream.mkString(Stream.decodeText(child.stdout)),
						Stream.mkString(Stream.decodeText(child.stderr)),
						child.exitCode
					],
					{ concurrency: 'unbounded' }
				);
				if (code !== 0)
					return yield* new PublicationFailed({
						message: `${command} ${args.join(' ')} failed: ${(stderr || stdout.slice(-4000) || `exit ${code}`).trim()}`
					});
				return stdout;
			})
		).pipe(Effect.mapError(PublicationFailed.from))
);
