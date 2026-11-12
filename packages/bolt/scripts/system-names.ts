/// <reference types="node" />
// Emit the system type index from the same declarations the runtime compiles, before any type checking/package emit.
import { fileURLToPath } from 'node:url';
import { Effect, FileSystem, Schema } from 'effect';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { SYSTEM } from '../src/system/index.ts';
import { literal } from '../src/tooling/literal.ts';

class SystemNamesFailed extends Schema.TaggedError<SystemNamesFailed>()('SystemNamesFailed', {
	message: Schema.String,
	cause: Schema.Defect()
}) {}

const text = `// Generated from src/system by scripts/system-names.ts. Do not edit.
export type SystemNames = {
	models: ${literal(SYSTEM.models, '\t')};
	relationships: ${literal(SYSTEM.relationships, '\t')};
	exposures: ${literal(SYSTEM.exposures, '\t')};
	integrations: ${literal(Object.fromEntries(Object.entries(SYSTEM.integrations).map(([name, spec]) => [name, { spec }])), '\t')};
};
`;

NodeRuntime.runMain(Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const target = fileURLToPath(new URL('../src/system/names.ts', import.meta.url));
	if ((yield* fs.exists(target)) && (yield* fs.readFileString(target)) === text) return;
	yield* fs.writeFileString(target, text);
}).pipe(
	Effect.mapError((cause) => new SystemNamesFailed({ message: 'The system names could not be generated.', cause })),
	Effect.provide(NodeServices.layer)
));
