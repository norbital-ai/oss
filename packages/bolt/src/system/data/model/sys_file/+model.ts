// A stored file (rules 18, 38d): the bytes are the files port's; the row is keyed by the client-minted upload id.
// Grantable; a /files upload inserts the row. The storage key stays the engine's.
import { bind_model } from '../../../../declarations.ts';

export default bind_model('sys_file')({
	description: 'A stored file: its name, type, size, digest and the field it was uploaded to.',
	record_label: 'record.name',
	fields: {
		name: { kind: 'text' },
		mime: { kind: 'text' },
		size: { kind: 'int' },
		key: { kind: 'text' },
		sha256: { kind: 'text' },
		field: { kind: 'text' },
		revision: { kind: 'int', default: 1 },
		created_at: { kind: 'instant' },
		created_by: { kind: 'text', optional: true },
		updated_at: { kind: 'instant', optional: true },
		updated_by: { kind: 'text', optional: true }
	},
	table: { primary: 'text' },
	outputs: {
		default: {
			fields: [
				'name',
				'mime',
				'size',
				'sha256',
				'field',
				'revision',
				'created_at',
				'created_by',
				'updated_at',
				'updated_by'
			]
		},
		meta: { fields: ['name', 'mime'] }
	}
});
