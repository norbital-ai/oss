import { total, unique } from './math.js';

export const run = (): string => {
	const amounts = [1, 2, 3];
	const names = unique(['a', 'b', 'a']);
	return `${total(amounts)}:${names.join(',')}`;
};
