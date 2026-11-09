import { expect, it } from 'vitest';
import { stepActive } from '../src/primitives/utils.ts';

it('an arrow step wraps, skips rows the list refuses, and stays when nothing is selectable', () => {
	expect(stepActive(0, 0, 1)).toBe(0);
	expect(stepActive(3, 0, 1)).toBe(1);
	expect(stepActive(3, 2, 1)).toBe(0);
	expect(stepActive(3, 0, -1)).toBe(2);
	expect(stepActive(3, 9, -1)).toBe(1);
	// the disabled middle row is stepped over both ways, including the wrap
	expect(stepActive(3, 0, 1, (i) => i !== 1)).toBe(2);
	expect(stepActive(3, 2, 1, (i) => i !== 1)).toBe(0);
	expect(stepActive(3, 2, -1, (i) => i !== 1)).toBe(0);
	expect(stepActive(2, 0, 1, () => false)).toBe(0);
});
