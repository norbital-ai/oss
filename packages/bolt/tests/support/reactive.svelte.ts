/** A deep `$state` proxy for a test outside a component: assigning to it re-renders what reads it. */
export function reactive<T extends object>(value: T): T {
	const s = $state(value);
	return s;
}
