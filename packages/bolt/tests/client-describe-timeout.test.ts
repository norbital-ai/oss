import { afterEach, expect, it, vi } from 'vitest';
import { createBolt } from '../src/client/bolt.ts';
afterEach(() => vi.useRealTimers());
it('a stalled describe transport rejects visibly and aborts; a retry succeeds', async () => {
	vi.useFakeTimers();
	let signal: AbortSignal | null | undefined;
	let calls = 0;
	let result = 'pending';
	let error: unknown;
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		calls++;
		signal = init?.signal;
		if (calls === 1) return new Promise<Response>(() => {});
		return Response.json({
			outcome: { kind: 'committed', output: { where: { kind: { eq: 'nda' } } }, records: [] },
			v: 0
		});
	};
	const bolt = createBolt({ actor: null, locale: 'en', fetch, describe: true });
	void bolt.describe!('template_documents', 'show latest version only').then(
		() => {
			result = 'resolved';
		},
		(e) => {
			result = 'rejected';
			error = e;
		}
	);
	await vi.advanceTimersByTimeAsync(15000);
	expect(result).toBe('rejected');
	expect(signal?.aborted).toBe(true);
	expect(error).toMatchObject({ name: 'TimeoutError', code: 'timeout' });
	expect((error as Error).message).toContain('Try again');
	await expect(bolt.describe!('template_documents', 'NDA templates')).resolves.toEqual({
		where: { kind: { eq: 'nda' } }
	});
});
it('a stalled describe response body is bounded as well as fetch', async () => {
	vi.useFakeTimers();
	let result = 'pending';
	const fetch: typeof globalThis.fetch = async () => {
		const response = Response.json({});
		response.json = () => new Promise(() => {});
		return response;
	};
	void createBolt({ actor: null, locale: 'en', fetch, describe: true }).describe!(
		'jobs',
		'open jobs'
	).catch(() => {
		result = 'rejected';
	});
	await vi.advanceTimersByTimeAsync(15000);
	expect(result).toBe('rejected');
});
it('the describe deadline never aborts a mutating act with unknown commit status', async () => {
	vi.useFakeTimers();
	let signal: AbortSignal | null | undefined;
	let result = 'pending';
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		signal = init?.signal;
		return new Promise(() => {});
	};
	void Promise.resolve(
		createBolt({ actor: null, locale: 'en', fetch, describe: true }).act('jobs.update', {
			id: 'job1',
			status: 'done'
		})
	).then(() => {
		result = 'settled';
	});
	await vi.advanceTimersByTimeAsync(15000);
	expect(result).toBe('pending');
	expect(signal).toBeUndefined();
});
