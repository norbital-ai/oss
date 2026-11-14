import { integration } from '@norbital-ai/bolt';

export default integration('erp', {
	description: 'The ERP API',
	driver: 'http',
	credential: { token: { kind: 'text' } },
	http: { base_url: 'https://erp.example/', auth: { bearer: 'token' } },
	test: function* (ctx) {
		yield* ctx.request({ method: 'GET', path: 'me', output: { kind: 'json' } });
	}
});
