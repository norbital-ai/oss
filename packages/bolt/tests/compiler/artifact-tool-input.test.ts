import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { renderArtifact } from '../../src/compiler/sync.js';

/**
 * How the artifact validates a workspace tool's input.
 *
 * The emitted dispatcher decodes with the author's Effect Schema directly. There is no adapter,
 * second schema library, or Promise validation path in between.
 */

const root = '/workspace';

/** The one statement in the artifact that turns declared tools into dispatchable handlers. */
const toolHandlers = (
	artifact: string,
	tool0: { readonly input: unknown; readonly run: (api: unknown, input: unknown) => unknown }
): Readonly<Record<string, (input: unknown, api: unknown) => unknown>> => {
	const start = artifact.indexOf('const toolHandlers = {');
	const end = artifact.indexOf('\n};\n', start);
	if (start < 0 || end < 0)
		throw new Error('the artifact no longer declares toolHandlers in one statement');
	const source = `${artifact.slice(start, end + '\n};'.length)}\nreturn toolHandlers;`;
	return new Function('tool0', 'Schema', source)(tool0, Schema) as Readonly<
		Record<string, (input: unknown, api: unknown) => unknown>
	>;
};

const artifactWithOneTool = (): string =>
	renderArtifact({
		metadata: { name: 'fixture', version: '1.0.0', description: 'Bolt workspace' },
		collections: [],
		relations: [],
		apps: [],
		policies: [],
		functions: [],
		toolFiles: [`${root}/src/capabilities/tools/+summarize.ts`],
		envoyFiles: [],
		automations: [],
		automationFiles: [],
		pipelineFiles: [],
		skills: [],
		prompt: 'You are the test workspace agent.',
		root,
		assetIndex: { browser: [], server: [] },
		customTypeDefinitions: [],
		environmentFile: undefined,
		migrations: []
	});

describe('artifact tool input validation', () => {
	it('validates a tool input declared with Effect Schema, and refuses what it rejects', () => {
		const handlers = toolHandlers(artifactWithOneTool(), {
			input: Schema.Struct({ limit: Schema.Int }),
			run: (_api, input) => input
		});

		expect(handlers['summarize']?.({ limit: 5 }, {})).toEqual({ limit: 5 });
		expect(() => handlers['summarize']?.({ limit: 'all' }, {})).toThrow();
	});

	/**
	 * A tool may answer with an Effect, and the dispatcher has to run it.
	 *
	 * The generated handler keeps it as an Effect; the runtime's one authored-handler interpreter
	 * executes it after binding the subject-scoped API.
	 */
	it('keeps an Effect-returning tool in Effect for the runtime interpreter', () => {
		const handlers = toolHandlers(artifactWithOneTool(), {
			input: Schema.Struct({ limit: Schema.Int }),
			run: (_api, input) => Effect.succeed({ ran: input })
		});

		expect(
			Effect.runSync(handlers['summarize']?.({ limit: 5 }, {}) as Effect.Effect<unknown>)
		).toEqual({
			ran: { limit: 5 }
		});
	});

	/**
	 * A tool whose schema is missing a member the input carries must not see that member.
	 *
	 * The handler passes the schema's *output* to `run`, not the raw input — which is what makes the
	 * declared schema a boundary rather than documentation. Passing the raw input through would leave
	 * every assertion above green while the tool received whatever the caller sent.
	 */
	it('hands the tool the decoded value rather than the raw input', () => {
		const handlers = toolHandlers(artifactWithOneTool(), {
			input: Schema.Struct({ limit: Schema.Int }),
			run: (_api, input) => input
		});

		expect(handlers['summarize']?.({ limit: 5, smuggled: 'value' }, {})).toEqual({
			limit: 5
		});
	});
});
