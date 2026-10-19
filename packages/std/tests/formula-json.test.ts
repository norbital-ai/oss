import { describe, expect, it } from '@effect/vitest';
import { compile, context, evaluate } from '../src/formula.ts';

describe('formula JSON results', () => {
	it('normalizes nested CEL lists, maps and integer literals', () => {
		const site = context({ amount: { kind: 'number' } }, { numbers: 'float' });
		const compiled = compile(site, '{"amounts": [amount, 2], "ok": true, "missing": null}', 'json');
		if ('error' in compiled) throw new Error(compiled.error);
		expect(evaluate(compiled, { amount: 1.5 })).toEqual({
			amounts: [1.5, 2],
			ok: true,
			missing: null
		});
	});

	it('still refuses undeclared roots', () => {
		expect(compile(context({}), 'missing', 'json')).toHaveProperty('error');
	});

	it('refuses values that cannot be represented as finite JSON', () => {
		for (const value of [
			NaN,
			Infinity,
			-Infinity,
			undefined,
			() => 1,
			new Date(),
			new Map([[1, 'value']]),
			9007199254740993n
		]) {
			const site = context(
				{},
				{ functions: { answer: { signature: 'answer(): dyn', fn: () => value } } }
			);
			const compiled = compile(site, 'answer()', 'json');
			if ('error' in compiled) throw new Error(compiled.error);
			expect(() => evaluate(compiled, {})).toThrow();
		}
	});
});
