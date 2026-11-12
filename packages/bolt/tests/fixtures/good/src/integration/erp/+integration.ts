import { integration } from '../../../.norbital/integrations/erp.ts';

export default integration({
	description: 'The ERP API',
	driver: 'http',
	credential: { token: { kind: 'text' } },
	http: { base_url: 'https://erp.example/', auth: { bearer: 'token' } },
	test: function* (ctx) {
		yield* ctx.request({ method: 'GET', path: 'me', output: { kind: 'json' } });
	}
});
