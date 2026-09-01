export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(getErrorMessage(value), { cause: value });
}

export function getErrorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === 'string') return value;
	if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'message')) {
		const msg = Reflect.get(value, 'message');
		return typeof msg === 'string' ? msg : String(msg);
	}
	return String(value);
}
