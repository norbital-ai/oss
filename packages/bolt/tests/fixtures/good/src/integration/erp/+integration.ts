import { integration } from '../../../../../../src/index.ts';

export default integration('erp', {
	description: 'The ERP API',
	driver: 'http',
	credential: { token: { kind: 'text', label: 'API token' } },
	http: { baseUrl: 'https://erp.example/', auth: { bearer: 'token' } },
	test: function* (ctx) {
		yield* ctx.request({ method: 'GET', path: 'me', output: { kind: 'json' } });
	}
});
