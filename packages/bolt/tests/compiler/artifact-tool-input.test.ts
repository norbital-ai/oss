import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { renderArtifact } from '../../src/compiler/sync.js';
import { runAuthoredHandler } from '../../src/runtime/app.js';

/**
 * How the artifact validates a workspace tool's input.
 *
 * The emitted dispatcher used to call `tool.input.parse(input)` — zod's method and no other
 * library's — while the remote dispatcher two lines above it already went through `~standard`. So
 * the *declaration* claimed to accept any schema and the *generated code* accepted exactly one, and
 * a tool declared with Effect Schema died on `parse is not a function` rather than on its input.
 *
 * The emitted statement is executed rather than pattern-matched, for the reason
 * `artifact-metadata.test.ts` gives: a grep passes on the spelling of a line, and what is at stake
 * here is whether the handler still refuses bad input at all. Effect and a hand-written Standard
 * Schema are both exercised, because "works for the library bolt happens to depend on" and "works
 * for any conforming schema" are separate claims and the first has already been bought at the cost
 * of the second once. The hand-written one is not a library at all, which is the point: it can only
 * pass if the dispatcher goes through `~standard` and nothing else.
 */

/** A conforming schema owing nothing to any library, accepting `{ limit: number }` and no more. */
const handWrittenLimitSchema = {
	'~standard': {
		version: 1,
		vendor: 'bolt-tests',
		validate: (value: unknown) => {
			const limit =
				typeof value === 'object' && value !== null ? Reflect.get(value, 'limit') : undefined;
			return typeof limit === 'number'
				? { value: { limit } }
				: { issues: [{ message: 'limit must be a number' }] };
		}
	}
};

const root = '/workspace';

/** The one statement in the artifact that turns declared tools into dispatchable handlers. */
const toolHandlers = (
	artifact: string,
	tool0: { readonly input: unknown; readonly run: (api: unknown, input: unknown) => unknown }
): Readonly<Record<string, (input: unknown, api: unknown) => Promise<unknown>>> => {
	const start = artifact.indexOf('const toolHandlers = {');
	const end = artifact.indexOf('\n};\n', start);
	if (start < 0 || end < 0)
		throw new Error('the artifact no longer declares toolHandlers in one statement');
	const source = `${artifact.slice(start, end + '\n};'.length)}\nreturn toolHandlers;`;
	// The real `runAuthoredHandler`, not a stand-in: the emitted statement imports it, and the
	// authoring surface's promise that a handler may return an Effect is only tested if the thing
	// that runs Effects is the thing under test.
	return new Function('tool0', 'runAuthoredHandler', source)(tool0, runAuthoredHandler) as Readonly<
		Record<string, (input: unknown, api: unknown) => Promise<unknown>>
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
		toolFiles: [`${root}/src/tools/+summarize.tool.ts`],
		envoyFiles: [],
		automations: [],
		automationFiles: [],
		pipelineFiles: [],
		skills: [],
		prompt: 'You are the test workspace agent.',
		root,
		assets: [],
		customTypeDefinitions: [],
		environmentFile: undefined,
		migrations: []
	});

describe('artifact tool input validation', () => {
	it('validates a tool input declared with Effect Schema, and refuses what it rejects', async () => {
		const handlers = toolHandlers(artifactWithOneTool(), {
			input: Schema.toStandardSchemaV1(Schema.Struct({ limit: Schema.Int })),
			run: (_api, input) => input
		});

		await expect(handlers['summarize']?.({ limit: 5 }, {})).resolves.toEqual({ limit: 5 });
		await expect(handlers['summarize']?.({ limit: 'all' }, {})).rejects.toThrow();
	});

	it('still validates a tool input declared by a schema owing nothing to any library', async () => {
		const handlers = toolHandlers(artifactWithOneTool(), {
			input: handWrittenLimitSchema,
			run: (_api, input) => input
		});

		await expect(handlers['summarize']?.({ limit: 5 }, {})).resolves.toEqual({ limit: 5 });
		await expect(handlers['summarize']?.({ limit: 'all' }, {})).rejects.toThrow();
	});

	/**
	 * A tool may answer with an Effect, and the dispatcher has to run it.
	 *
	 * This is the reason the emitted handler routes through `runAuthoredHandler` at all. Without a
	 * case for it, a change that dropped the call would leave every assertion above green while an
	 * Effect-returning tool handed the caller an unexecuted program instead of its result.
	 */
	it('runs a tool that answers with an Effect', async () => {
		const handlers = toolHandlers(artifactWithOneTool(), {
			input: Schema.toStandardSchemaV1(Schema.Struct({ limit: Schema.Int })),
			run: (_api, input) => Effect.succeed({ ran: input })
		});

		await expect(handlers['summarize']?.({ limit: 5 }, {})).resolves.toEqual({
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
	it('hands the tool the decoded value rather than the raw input', async () => {
		const handlers = toolHandlers(artifactWithOneTool(), {
			input: Schema.toStandardSchemaV1(Schema.Struct({ limit: Schema.Int })),
			run: (_api, input) => input
		});

		await expect(handlers['summarize']?.({ limit: 5, smuggled: 'value' }, {})).resolves.toEqual({
			limit: 5
		});
	});
});
