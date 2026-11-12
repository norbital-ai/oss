/** A missing fixture value fails at the point that needs it, in Node and in the browser. */
export const required = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Required fixture value is missing.');
	return value;
};
