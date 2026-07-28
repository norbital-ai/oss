import { Guard, requireAuthMiddleware } from '$lib/remote/guard.server.js';
import { requireRuntimeFacility } from '$lib/server/run/facilities.js';
import { StaticMapInputSchema } from './schema.js';

const authenticated = Guard.init().use(requireAuthMiddleware());

export const renderStaticMap = authenticated.query(StaticMapInputSchema, async (input) => {
	const { data, ...result } = await requireRuntimeFacility('maps').renderStaticMap(input);
	return {
		...result,
		dataBase64: Buffer.from(data).toString('base64')
	};
});
