// engine/pipelines' encoding, pure (rule 30).
import { describe, expect, it } from '@effect/vitest';
import { csv } from '../src/engine/pipelines/pipeline.ts';

describe('pipelines: export encoding', () => {
	it('csv quotes a field with a comma, quote or line break and doubles its quotes (RFC 4180)', () => {
		expect(
			csv([
				['a', 'b'],
				['x, y', 'say "hi"'],
				[null, 2]
			])
		).toBe('a,b\r\n"x, y","say ""hi"""\r\n,2');
	});
});
