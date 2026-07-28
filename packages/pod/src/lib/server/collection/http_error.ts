export class HttpError extends Error {
	readonly status: number;
	readonly body: Record<string, unknown>;

	constructor(status: number, body: string | Record<string, unknown>) {
		const normalized =
			typeof body === 'string'
				? { message: body }
				: { message: typeof body.message === 'string' ? body.message : 'Error', ...body };
		super(String(normalized.message));
		this.status = status;
		this.body = normalized;
	}
}

export function error(status: number, body: string | Record<string, unknown>): never {
	throw new HttpError(status, body);
}
