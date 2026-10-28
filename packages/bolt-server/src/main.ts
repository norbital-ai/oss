#!/usr/bin/env -S node --no-node-snapshot
import { Console, Effect, Layer, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { BoltError } from '@norbital-ai/bolt/engine';
import { hostFileOf } from '@norbital-ai/bolt/node';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { ServerLive } from './server.ts';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `--trust-proxy`: a comma list of CIDRs. */
const cidrs = (list: string) =>
	Effect.forEach(
		list
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s !== ''),
		(c) => {
			const [net = '', bits] = c.split('/');
			const v = isIP(net);
			return v === 0 || (bits !== undefined && !(/^\d+$/.test(bits) && Number(bits) <= (v === 6 ? 128 : 32)))
				? Effect.fail(BoltError.make('invalidSpec', 'admission', `--trust-proxy: '${c}' is not a CIDR`))
				: Effect.succeed(c);
		}
	);
/**
 * `bolt-server [workspace]`: serves the workspace's built release (`.norbital/bundle`, or `--artifact`) with its
 * `norbital.host.ts` (or `--host=<file>`). A workspace without a host file is Colony's to serve (tethered).
 */
const command = Command.make(
	'bolt-server',
	{
		workspace: Argument.String('workspace').pipe(Argument.withDefault('.')),
		hostFile: Flag.String('host').pipe(Flag.optional),
		artifact: Flag.String('artifact').pipe(Flag.optional),
		listen: Flag.String('listen').pipe(Flag.withDefault('127.0.0.1')),
		port: Flag.Int('port').pipe(Flag.withDefault(3100)),
		trustProxy: Flag.String('trust-proxy').pipe(Flag.optional),
		founder: Flag.String('founder').pipe(Flag.optional),
		seed: Flag.String('seed').pipe(Flag.optional)
	},
	(flags) =>
		Effect.gen(function* () {
			const root = resolve(flags.workspace);
			const hostFile = yield* hostFileOf(root, Option.getOrUndefined(flags.hostFile));
			if (Option.isNone(hostFile))
				return yield* Effect.fail(
					BoltError.make(
						'invalidSpec',
						'admission',
						`${root} has no norbital.host.ts: write one (or pass --host=<file>), or let Colony serve it`
					)
				);
			yield* Layer.launch(
				ServerLive({
					artifact: Option.getOrElse(flags.artifact, () => join(root, '.norbital', 'bundle')),
					hostFile: hostFile.value,
					host: flags.listen,
					port: flags.port,
					trustProxy: Option.isNone(flags.trustProxy) ? [] : yield* cidrs(flags.trustProxy.value),
					...(Option.isNone(flags.founder) ? {} : { founder: flags.founder.value }),
					...(Option.isNone(flags.seed) ? {} : { seed: flags.seed.value })
				})
			);
		})
);
export const main = (argv: readonly string[]) =>
	Command.runWith(command, { version: '1.0.0' })(argv).pipe(
		Effect.as(0),
		Effect.catchTag('BoltError', (error) => Console.error(error.message).pipe(Effect.as(1))),
		Effect.catch((error) => Console.error(error).pipe(Effect.as(2)))
	);
// a `bolt-server` bin is a symlink: compare the real path
if (
	process.argv[1] !== undefined &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
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
