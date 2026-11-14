import { custom_field } from '../../../../../../../src/index.ts';

export default custom_field({
	description: 'A score',
	shape: { kind: 'int', min: 1, max: 5 },
	validate: (value) => (value > 0 ? undefined : 'positive')
});
