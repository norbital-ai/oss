import { describe, expect, it } from 'vitest';
import { describeCause } from '../../src/runtime/workspace.js';

describe('workspace failure descriptions', () => {
	it('keeps a phase wrapper while exposing its native nested error', () => {
		const wrapped = Object.assign(new Error('generated wrapper message with cause {}'), {
			_tag: 'Bolt.Collections.MutationPhaseFailure',
			phase: 'settle',
			step: 'after-hook',
			collection: 'job_assignments',
			cause: new TypeError('previous is undefined')
		});

		expect(describeCause(wrapped)).toBe(
			'Bolt.Collections.MutationPhaseFailure (settle after-hook job_assignments): previous is undefined'
		);
	});
});
