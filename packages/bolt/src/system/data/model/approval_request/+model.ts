// An approval request (rules 44–47, §3.8): today's readable face of an approval — status, steps and the teams that
// decide — kept under its name (R3). At most one ongoing request per record.
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'An approval request on a record: its status, step and the teams that approve or supersede.',
	label: ['collection_name', 'record_id'],
	fields: {
		collection_name: { kind: 'text' },
		record_id: { kind: 'text' },
		action: { kind: 'text' },
		status: { kind: 'text' },
		step: { kind: 'int' },
		steps: { kind: 'int' },
		approver_teams: { kind: 'json' },
		superseder_teams: { kind: 'json' },
		applied_at: { kind: 'instant', optional: true },
		closed_at: { kind: 'instant', optional: true },
		closed_by: { kind: 'text', optional: true },
		revision: { kind: 'int', default: 1 },
		created_at: { kind: 'instant' },
	},
	unique: [{ fields: ['collection_name', 'record_id'], where: { status: { eq: 'ONGOING' } } }],
	table: { primary: 'uuid' },
});
