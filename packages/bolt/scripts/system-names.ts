/// <reference types="node" />
// Emit the system index (src/system/index.ts) from the system declaration folders, then its type index (names.ts)
// from the same declarations the runtime compiles, before any type checking/package emit.
import { fileURLToPath } from 'node:url';
import { Effect, FileSystem, Schema } from 'effect';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { literal } from '../src/tooling/literal.ts';

class SystemNamesFailed extends Schema.TaggedError<SystemNamesFailed>()('SystemNamesFailed', {
	message: Schema.String,
	cause: Schema.Defect()
}) {}

const HEADER = '// Generated from src/system by scripts/system-names.ts. Do not edit.\n';
const path = (relative: string) => fileURLToPath(new URL(`../src/system/${relative}`, import.meta.url));

const index_text = (models: readonly string[], integrations: readonly string[]) => `${HEADER}// Built-in declarations share the normal model compiler. The build emits their exact names types separately.
import type { ExposureSpec, ModelParts, ModelSpec } from '../decl/model.ts';
import { split_system_model } from '../decl/model-data.ts';
import type { RelationshipSpec } from '../decl/names.ts';
import type { IntegrationSpec } from '../decl/runtime/integration.ts';
${models.map((m) => `import m_${m} from './data/model/${m}/+model.ts';`).join('\n')}
${integrations.map((i) => `import i_${i} from './integration/${i}/+integration.ts';`).join('\n')}

const parts = [
${models.map((m) => `\tm_${m}`).join(',\n')}
].map((m): [string, ModelParts] => [m.name, split_system_model(m.name, m.spec)]);
/** The layer's manifest: merged into every workspace's schema plan, catalogue and names. */
export const SYSTEM: {
	models: { readonly [model: string]: ModelSpec };
	relationships: { readonly [key: string]: RelationshipSpec };
	exposures: { readonly [model: string]: ExposureSpec };
	integrations: { readonly [integration: string]: IntegrationSpec };
} = {
	models: Object.fromEntries(parts.map(([name, p]): [string, ModelSpec] => [name, p.model])),
	relationships: Object.fromEntries(parts.flatMap(([, p]) => Object.entries(p.relationships))),
	exposures: Object.fromEntries(
		parts.flatMap(([name, p]): [string, ExposureSpec][] =>
			p.exposure === undefined ? [] : [[name, p.exposure]]
		)
	),
	integrations: {
${integrations.map((i) => `\t\t${i}: i_${i}.spec`).join(',\n')}
	}
};
`;

NodeRuntime.runMain(Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const write = Effect.fnUntraced(function* (target: string, text: string) {
		if ((yield* fs.exists(target)) && (yield* fs.readFileString(target)) === text) return;
		yield* fs.writeFileString(target, text);
	});
	const folders = (relative: string) =>
		fs.readDirectory(path(relative)).pipe(Effect.map((names) => names.filter((name) => !name.startsWith('.')).sort()));
	yield* write(path('index.ts'), index_text(yield* folders('data/model'), yield* folders('integration')));
	const { SYSTEM } = yield* Effect.tryPromise(() => import('../src/system/index.ts'));
	yield* write(
		path('names.ts'),
		`${HEADER}export type SystemNames = {
	models: ${literal(SYSTEM.models, '\t')};
	relationships: ${literal(SYSTEM.relationships, '\t')};
	exposures: ${literal(SYSTEM.exposures, '\t')};
	integrations: ${literal(Object.fromEntries(Object.entries(SYSTEM.integrations).map(([name, spec]) => [name, { spec }])), '\t')};
};
`
	);
}).pipe(
	Effect.mapError((cause) => new SystemNamesFailed({ message: 'The system names could not be generated.', cause })),
	Effect.provide(NodeServices.layer)
));
