import { bind_model } from '../../src/declarations.ts';
import type { ModelLiteral } from '../../src/declarations.ts';
import message from '../../src/system/data/model/sys_message/+model.ts';
import configuration from '../../src/system/data/model/sys_config/+model.ts';

const renamed = bind_model('current_table')({
	description: 'Renamed records',
	was: 'prior_table',
	record_label: 'record.title',
	fields: { title: { kind: 'text', was: 'prior_title' } }
});
const previous: 'prior_table' = renamed.spec.was;
void previous;
const previousField: 'prior_title' = renamed.spec.fields.title.was;
void previousField;

bind_model('invalid_rename')({
	description: 'Invalid rename metadata',
	// @ts-expect-error a previous model name is text
	was: 123,
	record_label: 'record.title',
	fields: { title: { kind: 'text' } }
});

bind_model('workspace_table')({
	description: 'Workspace rows use engine keys',
	fields: { title: { kind: 'text' } },
	// @ts-expect-error physical key metadata belongs to the private built-in binding
	table: { primary: 'text' }
});

const keys: keyof ModelLiteral = 'record_label';
void keys;
// @ts-expect-error native table metadata is absent from the authoring literal
const native_key: keyof ModelLiteral = 'table';
void native_key;
const primary: 'text' = message.spec.table.primary;
const numbered: 'seq' = message.spec.table.identity;
const field_key: 'key' = configuration.spec.table.primary.field;
void primary;
void numbered;
void field_key;
