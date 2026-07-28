import { Guard, requireAuthMiddleware } from '$lib/remote/guard.server.js';
import { BrowserInputSchema } from './schema.js';

const authenticated = Guard.init().use(requireAuthMiddleware());

export const browser = authenticated.query(BrowserInputSchema, async (input) => {
	const resp = await fetch(input.url, {
		method: input.method ?? 'GET',
		headers: { 'content-type': 'application/json', ...(input.headers ?? {}) },
		body: input.body ?? undefined
	});
	return resp.json().catch(() => resp.text());
});
