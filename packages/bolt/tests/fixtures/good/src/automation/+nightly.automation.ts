import { automation } from '../../../../../src/index.ts';

const a = automation({ description: 'Nightly', on: { cron: '0 2 * * *' }, runAs: ['sales_rep'] });
a.run(function* () {});
export default a;
