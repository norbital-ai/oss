import { describe, expect, it } from 'vitest';
import { projectConversations } from '../src/client/ui/agent/conversation-selector.js';

const root = {
	id: '00000000-0000-4000-8000-000000000101',
	agent_id: 'web',
	audience: 'personal',
	status: 'ready'
};

describe('projectConversations', () => {
	it('keeps a Task when live sync omits null parent and run keys', () => {
		expect(projectConversations([root])).toEqual([
			{
				...root,
				title: null,
				parent_id: null,
				active_plan_id: null,
				active_turn_id: null
			}
		]);
	});
	it('keeps the automatic title from a synced conversation', () => {
		expect(projectConversations([{ ...root, title: 'Review the CRM records' }])[0]?.title).toBe(
			'Review the CRM records'
		);
	});

	it('keeps a Task when those keys arrive as null', () => {
		expect(
			projectConversations([
				{
					...root,
					parent_id: null,
					active_plan_id: null,
					active_turn_id: null
				}
			])
		).toHaveLength(1);
	});
});
