import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	defineAutomation,
	defineCommandHandler,
	defineConnection,
	defineModel,
	custom,
	file,
	hexToBinaryEmbedding,
	numeric,
	text,
	vector
} from '../../src/authoring/index.js';
import { defineAgentTool } from '../../src/authoring/agent-tools.js';

describe('Bolt authoring contracts', () => {
	it('makes manual invocation inherent and keeps automatic-trigger authoring closed', () => {
		const spec = {
			description: 'Exercise an automation trigger.',
			policies: ['operator'],
			handler: () => ({ ok: true })
		} as const;
		const manualOnly = defineAutomation({}, spec);
		const scheduled = defineAutomation({ schedule: '0 6 * * *' }, spec);

		expect(manualOnly.trigger).toEqual({});
		expect(scheduled.trigger).toEqual({ schedule: '0 6 * * *' });
		// Clean-cut means the removed spelling does not survive as an ignored structural extra.
		if (false) {
			// @ts-expect-error `manual` is not part of the authoring API; `{}` is manual-only.
			defineAutomation({ manual: true }, spec);
		}
		expect(() => defineAutomation({ manual: true } as never, spec)).toThrow(
			/unsupported property/u
		);
		expect(() => defineAutomation({ schedule: '' } as never, spec)).toThrow(/non-empty cron/u);
	});

	it('builds the missing temporal and vector column primitives', () => {
		expect(custom('instant_range').notNull).toBeTypeOf('function');
		expect(vector({ dimensions: 3 }).notNull).toBeTypeOf('function');
		expect(() => vector({ dimensions: 0 })).toThrow();
	});

	/**
	 * The dimension check moved from a zod chain to an Effect `Schema`, and every rejection the chain
	 * made is asserted here rather than inferred from the types — `z.number().int().positive().max()`
	 * and its replacement have the same *declared* parameter type, so nothing about the signature
	 * would have changed had the replacement silently accepted a fraction.
	 */
	it('still refuses every vector width the declaration cannot mean', () => {
		expect(vector({ dimensions: 16_000 }).notNull).toBeTypeOf('function');
		for (const dimensions of [0, -1, 1.5, 16_001, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => vector({ dimensions })).toThrow();
		}
	});

	it('expands hexadecimal binary embeddings deterministically', () => {
		expect(hexToBinaryEmbedding('a0')).toEqual([1, 0, 1, 0, 0, 0, 0, 0]);
		expect(() => hexToBinaryEmbedding('xyz')).toThrow();
	});

	it('keeps embedding sources tied to declared text or file fields', () => {
		const declaration = defineModel(
			{ title: text(), photo: file(), amount: numeric() },
			{ embedding: { fields: ['title', 'photo'], dimensions: 384 } }
		);
		expect(declaration.metadata?.embedding?.fields).toEqual(['title', 'photo']);
		expect(() =>
			defineModel(
				{ title: text() },
				{ embedding: { fields: ['missing'] } } as never
			)
		).toThrow(/undeclared field missing/u);
		expect(() =>
			defineModel(
				{ amount: numeric() },
				{ embedding: { fields: ['amount'] } }
			)
		).toThrow(/must be text or file data/u);
		expect(() =>
			defineModel({ title: text() }, { embedding: { fields: [] } })
		).toThrow(/at least one source field/u);
	});

	it('preserves command and connection declaration inference', () => {
		const command = defineCommandHandler({
			description: 'Returns the input.',
			schema: Schema.Struct({ id: Schema.String }),
			handler: ({ id }) => id
		});
		const connection = defineConnection({
			baseUrl: 'https://example.test',
			authentication: { type: 'bearer', token: { env: 'TOKEN' } }
		});
		expect(command.kind).toBe('command');
		expect(connection.authentication.token.env).toBe('TOKEN');
	});

	it('declares a workspace agent tool with a non-empty description', () => {
		const tool = defineAgentTool({
			description: 'Summarize open tickets',
			input: Schema.Struct({ limit: Schema.optionalKey(Schema.Finite) }),
			run: (_api, input) => ({ ok: true, limit: input.limit ?? 10 })
		});
		expect(tool.description).toBe('Summarize open tickets');
		expect(() =>
			defineAgentTool({
				description: '  ',
				input: Schema.Struct({}),
				run: () => null
			})
		).toThrow(/description/);
	});

	/**
	 * A tool's input schema is the author's, declared as the realm's native Effect `Schema`.
	 *
	 * The declaration used to name `z.ZodType`, so a workspace could only describe a tool's input
	 * with the one library bolt happened to import. It now names Effect `Schema` outright, and this
	 * asserts what that is worth: a raw `Schema.Struct` type-checks without any adapter the author
	 * writes, `run` still receives the schema's *output* type rather than `unknown`, and the
	 * compiler validates directly with Effect Schema, so the schema still rejects.
	 */
	it('accepts a tool input schema declared as Effect Schema, with its output type intact', () => {
		const tool = defineAgentTool({
			description: 'Summarize open tickets',
			input: Schema.Struct({ limit: Schema.Int }),
			// `limit` resolving to `unknown` would fail this arithmetic at compile time, which is the
			// point: the assertion is that inference survived, not merely that the call compiled.
			run: (_api, input) => input.limit * 2
		});
		expect(Schema.decodeUnknownExit(tool.input)({ limit: 21 })._tag).toBe('Success');
		expect(Schema.decodeUnknownExit(tool.input)({ limit: 'all of them' })._tag).toBe('Failure');
	});
});
