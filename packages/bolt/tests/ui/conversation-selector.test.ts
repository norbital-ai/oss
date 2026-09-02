import { describe, expect, it } from 'vitest';
import { projectAgentTasks } from '../../src/client/ui/agent/conversation-selector.js';

const root = {
	id: '00000000-0000-4000-8000-000000000101',
	agent_id: 'web',
	audience: 'personal',
	status: 'ready'
};

describe('projectAgentTasks', () => {
	it('keeps a Task when live sync omits null parent and run keys', () => {
		expect(projectAgentTasks([root])).toEqual([
			{
				...root,
				parent_id: null,
				active_plan_id: null,
				active_run_id: null
			}
		]);
	});

	it('keeps a Task when those keys arrive as null', () => {
		expect(
			projectAgentTasks([
				{
					...root,
					parent_id: null,
					active_plan_id: null,
					active_run_id: null
				}
			])
		).toHaveLength(1);
	});
});
