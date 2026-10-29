import { automation } from '../../../../../src/index.ts';

export default automation('nightly', {
	description: 'Nightly',
	on: { cron: '0 2 * * *' },
	policies: ['sales_rep'],
	run: function* () {}
});
