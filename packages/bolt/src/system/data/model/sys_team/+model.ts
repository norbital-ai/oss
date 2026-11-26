// A team: the policies its members hold, and an optional parent that scopes data (`actor.team_tree`) without lending
// its policies. Only an administrator writes it; a member, an invitation, an API key or another team's `parent` that
// names a team keeps it from being deleted.
import { bind_system_model } from '../../../../decl/model.ts';

export default bind_system_model('sys_team')({
	icon: 'lucide:users',
	description: 'A team: its name, its parent team and the policies its members hold.',
	record_label: 'record.name',
	fields: {
		name: { kind: 'text' },
		/** Scopes data to the team and its descendants; confers no policy. */
		parent: { kind: 'ref', to: 'sys_team', optional: true, on_delete: 'restrict' },
		/** Policy handles declared in source; what every member of the team holds. */
		policies: { kind: 'text', format: 'policy', many: true, default: [] },
		created_at: { kind: 'instant', default: { var: 'now' } },
		revision: { kind: 'int', default: 1 }
	},
	table: { primary: 'text' },
	outputs: { default: { fields: 'all' } },
	create: { fields: ['name', 'parent', 'policies'] },
	update: { fields: ['name', 'parent', 'policies'] },
	delete: {}
});
