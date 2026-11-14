// The one queue: a run is a row with a `due_at`. `key` is the "one queued, unstarted run per
// key" (an `on conflict` arbiter); a claim moves a workspace run's key to `run_key`. No grant: read through ctx.runs,
// RunStatus, RunsFor and /runs.
import { bind_system_model } from '../../../../decl/model.ts';

export default bind_system_model('sys_run')({
	description:
		'An automation run: queued, running, waiting or finished, with its input, progress and results.',
	record_label: 'record.automation',
	fields: {
		automation: { kind: 'text' },
		input: { kind: 'json' },
		due_at: { kind: 'instant' },
		key: { kind: 'text', optional: true },
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
		// who or what started an automation run (`RunTrigger`); never its authority
		trigger: { kind: 'json', optional: true },
		// a waiting run's wait (`engine/runs/wait.ts`): what it waits on, the crossings it answered so far, what woke it
		wait: { kind: 'json', optional: true }
	},
	constraints: { key: { unique: ['key'] } },
	table: { primary: 'text' },
	outputs: { default: { fields: 'all' } },
	indexes: {
		by_due_at: { on: ['due_at'], where: { state: { eq: 'queued' } } },
		by_waiting: { on: ['due_at'], where: { state: { eq: 'waiting' } } },
		by_automation_state: { on: ['automation', 'state'] }
	}
});
