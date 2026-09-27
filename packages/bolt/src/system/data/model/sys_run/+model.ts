// The one queue (rules 48–52a): a run is a row with a `due_at`. `key` is rule 51's "one queued, unstarted run per
// key" (an `on conflict` arbiter); a claim moves a workspace run's key to `run_key`.
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'An automation run: queued, running or finished, with its input, progress and results.',
	label: 'automation',
	fields: {
		automation: { kind: 'text' },
		input: { kind: 'json' },
		due_at: { kind: 'instant' },
		key: { kind: 'text', optional: true, unique: true },
		cause: { kind: 'text' },
		depth: { kind: 'int' },
		state: { kind: 'text', default: 'queued' },
		attempts: { kind: 'int', default: 0 },
		leases: { kind: 'int', default: 0 },
		run_key: { kind: 'text', optional: true },
		started_at: { kind: 'instant', optional: true },
		finished_at: { kind: 'instant', optional: true },
		progress: { kind: 'json', optional: true },
		output: { kind: 'json', optional: true },
		error: { kind: 'json', optional: true },
		results: { kind: 'json', default: [] },
		actor: { kind: 'text', optional: true },
		starter: { kind: 'json', optional: true },
	},
	table: { primary: 'text', indexes: [{ on: ['due_at'], where: { state: { eq: 'queued' } } }] },
});
