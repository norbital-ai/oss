import { describe, expect, it } from 'vitest';
import type { CrossCall } from '../src/engine/services.ts';
import { journalEntry, replayed } from '../src/engine/runs/wait.ts';

describe('durable crossing identity', () => {
	const call = (text: string): CrossCall => ({
		_tag: 'files.put',
		args: [{ $bin: 0 }, { name: 'measurements.txt', mime: 'text/plain' }],
		bins: [new TextEncoder().encode(text)]
	});
	it('rejects changed binary content even when the byte length is unchanged', () => {
		const entry = journalEntry(call('100'), { ok: true, value: { id: 'original' } });
		expect(replayed([entry], 0, call('900'))).toBe('diverged');
	});
	it('replays identical content from another buffer with its recorded binary answer', () => {
		const answer = { ok: true as const, value: { $bin: 0 }, bins: [new Uint8Array([1, 2, 3])] };
		const entry = journalEntry(call('100'), answer);
		expect(replayed([entry], 0, call('100'))).toEqual(answer);
		expect(replayed([entry], 1, call('100'))).toBeUndefined();
	});
	it('rejects a changed argument even when the bytes are identical', () => {
		const entry = journalEntry(call('100'), { ok: true, value: null });
		expect(
			replayed([entry], 0, { ...call('100'), _tag: 'files.get', args: ['another-file'] })
		).toBe('diverged');
	});
});
