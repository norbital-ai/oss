import { envoy } from '../../../../../../src/index.ts';

export default envoy({
	name: 'Norbius',
	audience: 'private',
	policies: ['sales_rep'],
	delegation: 'disabled',
	task: 'Answer order questions.'
});
