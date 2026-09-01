import { describe, expect, it } from 'vitest';
import { TaskId } from '@norbital-ai/bolt-protocol';
import { taskAssetStorageKey } from '../../src/runtime/agents/agents.js';

describe('Task image asset boundary', () => {
	it('derives an opaque, Task-scoped storage key without a document command surface', () => {
		const first = TaskId.make('00000000-0000-4000-8000-000000000201');
		const second = TaskId.make('00000000-0000-4000-8000-000000000202');
		const key = taskAssetStorageKey(first, 'document-a', 'site-plan.png');

		expect(key).toMatch(/^agent-tasks\/[^/]+\/[^/]+\.png$/u);
		expect(key).not.toContain(first);
		expect(taskAssetStorageKey(second, 'document-a', 'site-plan.png')).not.toBe(key);
	});
});
