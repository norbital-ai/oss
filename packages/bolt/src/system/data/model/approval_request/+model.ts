// An approval request (rules 44–47, §3.8): today's readable face of an approval — its status, the step it waits on, the
// names of every step, and the teams and members that decide — kept under its name (R3). Read by its participants;
// written by the approvals engine. At most one open request per record: the lock refuses a second.
import { model } from '../../../../decl/model.ts';

const names = { kind: 'json', shape: { kind: 'list', of: { kind: 'text' } } } as const;

export default model('approval_request', {
	description:
		'An approval request on a record: its status, its steps, and the teams and members that approve or supersede.',
	label: ['collection_name', 'record_id'],
	fields: {
		collection_name: { kind: 'text' },
		record_id: { kind: 'text' },
		action: { kind: 'enum', values: ['create', 'update', 'delete'] },
		status: {
			kind: 'enum',
			values: ['ONGOING', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'SUPERSEDED']
		},
		/** The step it waits on (0-based), of `steps`. */
		step: { kind: 'int' },
		steps: { kind: 'int' },
		/** Every step's name, in order (the flow's `step(name, …)`). */
		step_names: names,
		/** The current step's approving team handles. */
		approver_teams: names,
		/** The current step's approving members (`sys_user` ids). */
		approver_users: names,
		superseder_teams: names,
		closed_at: { kind: 'instant', optional: true },
		closed_by: { kind: 'text', optional: true },
		revision: { kind: 'int', default: 1 },
		created_at: { kind: 'instant' }
	},
	unique: [{ fields: ['collection_name', 'record_id'], where: { status: { eq: 'ONGOING' } } }],
	table: { primary: 'uuid' },
	read: { fields: 'all' }
});
