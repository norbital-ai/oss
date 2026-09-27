// The workspace log (§5.12): an event per line, numbered by the database (the log page's cursor).
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'A workspace log event: its severity, name, invocation and attributes.',
	label: 'event',
	fields: {
		at: { kind: 'instant' },
		severity: { kind: 'text' },
		event: { kind: 'text' },
		invocation: { kind: 'text' },
		run: { kind: 'text', optional: true },
		conversation: { kind: 'text', optional: true },
		turn: { kind: 'text', optional: true },
		attributes: { kind: 'json' },
	},
	table: { primary: 'identity' },
});
