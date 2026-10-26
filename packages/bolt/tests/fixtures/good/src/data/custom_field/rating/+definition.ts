import { customField } from '../../../../../../../src/index.ts';

export default customField('rating', {
	description: 'A score',
	shape: { kind: 'int', min: 1, max: 5 },
	validate: (value) => (value > 0 ? undefined : 'positive')
});
