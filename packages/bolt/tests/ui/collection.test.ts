import { describe, expect, it } from 'vitest';
import { popDetail, pushDetail } from '../../src/client/ui/state/platform.js';

describe('collection UI state', () => {
	it('preserves nested record navigation and removes only the active detail', () => {
		const stack = pushDetail(pushDetail([], { collection: 'people', recordId: 'p1' }), {
			collection: 'teams',
			recordId: 't1'
		});
		expect(popDetail(stack)).toEqual([{ collection: 'people', recordId: 'p1' }]);
		expect(stack).toHaveLength(2);
	});
});
