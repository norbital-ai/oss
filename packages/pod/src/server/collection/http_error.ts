import { PodHttpError } from '$lib/server/http.js';

/** Collection failures share the runtime HTTP base so expected 4xx responses are not logged as 500s. */
export class HttpError extends PodHttpError {}

export function error(status: number, body: string | Record<string, unknown>): never {
	throw new HttpError(status, body);
}
