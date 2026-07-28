export class PodHttpError extends Error {
	readonly body: Readonly<Record<string, unknown>>;

	constructor(
		readonly status: number,
		body: string | Readonly<Record<string, unknown>>
	) {
		const normalized =
			typeof body === 'string'
				? { message: body }
				: { message: typeof body.message === 'string' ? body.message : 'Error', ...body };
		super(String(normalized.message));
		this.name = 'PodHttpError';
		this.body = normalized;
	}
}

export function error(status: number, body: string | Readonly<Record<string, unknown>>): never {
	throw new PodHttpError(status, body);
}

export function json(data: unknown, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers);
	headers.set('content-type', 'application/json; charset=utf-8');
	return new Response(JSON.stringify(data), { ...init, headers });
}

export function redirect(status: number, location: string): never {
	const redirectError = new PodHttpError(status, `Redirect to ${location}`);
	Object.defineProperty(redirectError, 'location', { value: location });
	throw redirectError;
}
