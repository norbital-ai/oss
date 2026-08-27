import { describe, expect, it } from 'vitest';
import { LatestQuery } from '../../src/client/ui/state/platform.js';

describe('shell query state', () => {
	it('drops stale finder results after a newer query starts', async () => {
		const latest = new LatestQuery<string>();
		let finishFirst: ((value: string) => void) | undefined;
		const first = latest.run(
			() =>
				new Promise((resolve) => {
					finishFirst = resolve;
				})
		);
		const second = latest.run(() => Promise.resolve('new'));
		finishFirst?.('old');
		expect(await second).toBe('new');
		expect(await first).toBeUndefined();
	});
});
