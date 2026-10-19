import { integration } from '../../../../../../src/index.ts';

const erp = integration('erp', {
	description: 'The ERP API',
	driver: 'http',
	credential: { token: { kind: 'text', label: 'API token' } },
	http: { baseUrl: 'https://erp.example/', auth: { bearer: 'token' } }
});
erp.test(function* (ctx) {
	yield* ctx.request({ method: 'GET', path: 'me', output: { kind: 'json' } });
});
export default erp;
