import { model } from '../../src/index.ts';

const renamed = model('current_table', {
	description: 'Renamed records',
	was: 'prior_table',
	label: 'title',
	fields: { title: { kind: 'text' } }
});
const previous: 'prior_table' = renamed.spec.was;
void previous;

model('invalid_rename', {
	description: 'Invalid rename metadata',
	// @ts-expect-error a previous model name is text
	was: 123,
	label: 'title',
	fields: { title: { kind: 'text' } }
});
