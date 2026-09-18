import { describe, expect, it } from 'vitest';
import { defineCollection, defineModel, numeric, text, vector } from '../src/authoring/index.js';
import { compileCollectionWrite } from '../src/authoring/model-introspection.js';

const model = defineModel({
	code: text(),
	lab_l: numeric(),
	lab_a: numeric(),
	lab_b: numeric(),
	lab_vector: vector({ dimensions: 3 })
});

describe('similarity index declarations', () => {
	it('projects the descriptor without its functions, defaulting the metric to l2', () => {
		const declaration = defineCollection({
			model,
			create: { input: { columns: { code: true, lab_l: true, lab_a: true, lab_b: true } } },
			similarity: {
				colour: {
					label: 'Colour',
					column: 'lab_vector',
					input: {
						l: { kind: 'number', label: 'L*', min: 0, max: 100, step: 0.1 },
						a: { kind: 'number', label: 'a*' },
						b: { kind: 'number', label: 'b*' }
					},
					embed: (row) => {
						const { lab_l, lab_a, lab_b } = row as {
							lab_l?: unknown;
							lab_a?: unknown;
							lab_b?: unknown;
						};
						return lab_l == null ? null : [Number(lab_l), Number(lab_a), Number(lab_b)];
					},
					target: (input) => [Number(input['l']), Number(input['a']), Number(input['b'])]
				}
			}
		});
		const compiled = compileCollectionWrite(declaration);
		expect(compiled.similarity).toEqual([
			{
				name: 'colour',
				label: 'Colour',
				column: 'lab_vector',
				metric: 'l2',
				input: [
					{ name: 'l', label: 'L*', kind: 'number', min: 0, max: 100, step: 0.1 },
					{ name: 'a', label: 'a*', kind: 'number' },
					{ name: 'b', label: 'b*', kind: 'number' }
				]
			}
		]);
		expect(JSON.stringify(compiled)).not.toContain('embed');
	});

	it('refuses an index that cannot be asked or answered', () => {
		expect(() =>
			defineCollection({
				model,
				similarity: {
					Colour: {
						column: 'lab_vector',
						input: { l: { kind: 'number' } },
						embed: () => null,
						target: () => []
					}
				}
			})
		).toThrow(/lower-case/);
		expect(() =>
			defineCollection({
				model,
				similarity: {
					colour: { column: 'lab_vector', input: {}, embed: () => null, target: () => [] }
				}
			})
		).toThrow(/at least one control/);
		expect(() =>
			defineCollection({
				model,
				similarity: {
					colour: {
						column: 'lab_vector',
						input: { base: { kind: 'reference' } },
						embed: () => null,
						target: () => []
					}
				}
			})
		).toThrow(/reference with no collection/);
		expect(() =>
			defineCollection({
				model,
				similarity: {
					semantic: {
						column: 'lab_vector',
						input: { l: { kind: 'number' } },
						embed: () => null,
						target: () => []
					}
				}
			})
		).toThrow(/platform's own search command/);
		expect(() =>
			defineCollection({
				model,
				similarity: {
					colour: {
						column: 'lab_vector',
						metric: 'hamming' as never,
						input: { l: { kind: 'number' } },
						embed: () => null,
						target: () => []
					}
				}
			})
		).toThrow(/metric/);
		expect(() =>
			defineCollection({
				model,
				similarity: {
					colour: {
						column: 'lab_vector',
						input: { l: { kind: 'number' } },
						embed: () => null
					} as never
				}
			})
		).toThrow(/target/);
	});
});
