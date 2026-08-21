export function getErrorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object' && 'message' in value) {
		const msg = (value as { message: unknown }).message;
		return typeof msg === 'string' ? msg : String(msg);
	}
	return String(value);
}
