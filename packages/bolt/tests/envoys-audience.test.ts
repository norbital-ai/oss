import { describe, expect, it } from 'vitest';
import { envoy } from '../src/authoring/workspace-schema.js';

describe('envoy audience', () => {
	it('refuses an audience the union does not name', () => {
		expect(() =>
			envoy({
				name: 'loose',
				channel: 'whatsapp',
				// @ts-expect-error `private` is gone: every linked member's turn is capped by the envoy.
				audience: 'private',
				policies: ['desk'],
				delegation: 'disabled',
				task: 'Answer.'
			})
		).toThrow(/unsupported audience/);
	});
});
