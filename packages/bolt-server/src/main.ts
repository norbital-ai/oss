#!/usr/bin/env -S node --no-node-snapshot
import { Console, Effect, Layer, Option } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { BoltConfig } from './config.ts';
import { ServerLive } from './server.ts';
const command = Command.make(
	'bolt-server',
	{
		port: Flag.integer('port').pipe(Flag.optional),
		dev: Flag.boolean('dev').pipe(Flag.withDefault(false)),
		trustProxy: Flag.string('trust-proxy').pipe(Flag.optional),
		founder: Flag.string('founder').pipe(Flag.optional),
		seed: Flag.string('seed').pipe(Flag.optional)
	},
	(flags) =>
		Effect.gen(function* () {
			const config = yield* BoltConfig({
				...(Option.isNone(flags.port) ? {} : { port: flags.port.value }),
				dev: flags.dev,
				...(Option.isNone(flags.trustProxy) ? {} : { trustProxy: flags.trustProxy.value }),
				...(Option.isNone(flags.founder) ? {} : { founder: flags.founder.value }),
				...(Option.isNone(flags.seed) ? {} : { seed: flags.seed.value })
			});
			yield* Layer.launch(ServerLive(config));
		})
);
export const main = (argv: readonly string[]) =>
	Command.runWith(command, { version: '1.0.0' })(argv).pipe(
		Effect.as(0),
		Effect.catchTag('ConfigError', (error) => Console.error(error.message).pipe(Effect.as(1))),
		Effect.catchTag('BoltError', (error) => Console.error(error.message).pipe(Effect.as(1))),
		Effect.catch((error) => Console.error(error).pipe(Effect.as(2)))
	);
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href)
	NodeRuntime.runMain(
		main(process.argv.slice(2)).pipe(
			Effect.tap((code) =>
				Effect.sync(() => {
					process.exitCode = code;
				})
			),
			Effect.provide(NodeServices.layer)
		)
	);
