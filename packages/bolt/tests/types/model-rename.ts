import { model } from '../../src/index.ts';

const renamed = model('current_table', {
	description: 'Renamed records',
	was: 'prior_table',
	record_label: 'record.title',
	fields: { title: { kind: 'text', was: 'prior_title' } }
});
const previous: 'prior_table' = renamed.spec.was;
void previous;
const previousField: 'prior_title' = renamed.spec.fields.title.was;
void previousField;

model('invalid_rename', {
	description: 'Invalid rename metadata',
	// @ts-expect-error a previous model name is text
	was: 123,
	record_label: 'record.title',
	fields: { title: { kind: 'text' } }
});
