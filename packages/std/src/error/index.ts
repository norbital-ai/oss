export interface ErrorSummary {
	name: string;
	message: string;
	stack?: string;
	causes: Array<{ name: string; message: string }>;
}

export function summarizeError(error: unknown): ErrorSummary {
	if (!(error instanceof Error)) return { name: typeof error, message: String(error), causes: [] };

	const causes: ErrorSummary['causes'] = [];
	let current: unknown = error.cause;
	let depth = 0;
	while (current instanceof Error && depth < 5) {
		causes.push({ name: current.name, message: current.message });
		current = current.cause;
		depth += 1;
	}

	return {
		name: error.name,
		message: error.message,
		stack: error.stack?.split('\n').slice(0, 6).join('\n'),
		causes
	};
}

export function getErrorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object' && 'message' in value) {
		const msg = (value as { message: unknown }).message;
		return typeof msg === 'string' ? msg : String(msg);
	}
	return String(value);
}
