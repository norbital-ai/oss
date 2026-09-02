export function total(values: ReadonlyArray<number>): number {
	return values.reduce((sum, value) => sum + value, 0);
}

export function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
	return [...new Set(values)].sort();
}
