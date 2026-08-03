const POD_HTTP_ERROR = Symbol.for('@norbital-ai/pod/http-error');

export class PodHttpError extends Error {
	readonly body: Readonly<Record<string, unknown>>;
	readonly [POD_HTTP_ERROR] = true;

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

/**
 * Runtime bundles can contain an authoring copy and a server copy of Pod. `instanceof` compares
 * constructor identity and therefore misclassifies an intentional refusal thrown by the authoring
 * copy as an internal fault in the server copy. A global-symbol brand preserves the trust marker
 * without accepting arbitrary Error-shaped values.
 */
export function isPodHttpError(value: unknown): value is PodHttpError {
	if (!value || typeof value !== 'object') return false;
	return (
		Reflect.get(value, POD_HTTP_ERROR) === true &&
		Number.isInteger(Reflect.get(value, 'status')) &&
		Reflect.get(value, 'body') != null &&
		typeof Reflect.get(value, 'body') === 'object'
	);
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
