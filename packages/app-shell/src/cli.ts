#!/usr/bin/env node
import { Effect, Option, Schema } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { resolve } from 'node:path';
import { doctor } from './doctor.ts';
import { generate } from './generate.ts';
import { init } from './init.ts';
import { AppShellFailure } from './process.ts';
import { build, deploy, PLATFORMS, run } from './release.ts';

const dir = Argument.String('dir').pipe(Argument.withDefault('.'));
const Platforms = Schema.Array(Schema.Literals(['ios', 'android']));
/** `--platform ios,android`, each named once. */
const platforms = (value: string) =>
	Schema.decodeUnknownEffect(Platforms)(value.split(',').map((part) => part.trim())).pipe(
		Effect.map((list) => [...new Set(list)]),
		Effect.mapError(
			() =>
				new AppShellFailure({
					message: `--platform takes ${PLATFORMS.join(', ')} (comma-separated)`
				})
		)
	);
const platformList = Flag.String('platform').pipe(Flag.withDefault('ios,android'));

const appShell = Command.make('norbital-app').pipe(
	Command.withSubcommands([
		Command.make('init', { dir: Argument.String('dir') }, ({ dir }) => init(resolve(dir))),
		Command.make('generate', { dir }, ({ dir }) => generate(resolve(dir)).pipe(Effect.asVoid)),
		Command.make('doctor', { dir }, ({ dir }) => doctor(resolve(dir))),
		Command.make(
			'run',
			{
				dir,
				platform: Flag.Literals('platform', ['ios', 'android']),
				target: Flag.String('target').pipe(Flag.optional)
			},
			({ dir, platform, target }) => run(resolve(dir), platform, Option.getOrUndefined(target))
		),
		Command.make('build', { dir, platform: platformList }, ({ dir, platform }) =>
			platforms(platform).pipe(Effect.flatMap((list) => build(resolve(dir), list)))
		),
		Command.make('deploy', { dir, platform: platformList }, ({ dir, platform }) =>
			platforms(platform).pipe(Effect.flatMap((list) => deploy(resolve(dir), list)))
		)
	])
);

NodeRuntime.runMain(
	Command.runWith(appShell, { version: '0.0.1' })(process.argv.slice(2)).pipe(
		Effect.provide(FetchHttpClient.layer),
		Effect.provide(NodeServices.layer)
	)
);
