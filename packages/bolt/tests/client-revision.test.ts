// `$bolt.get(c, id, undefined, { revision })` (L-BOLT-181, the record scrubber): the wire carries `{ revision }`, and a
// past revision is history, so it never moves the client ledger an update's `observed` is taken from (rule 25).
import { expect, it } from 'vitest';
import { createBolt } from '../src/client/bolt.ts';

it('a revision get sends { revision } and leaves the ledger at the live revision', async () => {
	const sent: { url: string; body: { reads?: { m: string; a: unknown[] }[]; observed?: unknown } }[] = [];
	const fetch = (async (url: string, init: { body: string }) => {
		const body = JSON.parse(init.body);
		sent.push({ url, body });
		const a = body.reads?.[0]?.a;
		if (a !== undefined) return Response.json({ answers: [{ id: 'j1', revision: a[2]?.revision ?? 3, title: a[2]?.revision === undefined ? 'live' : 'past' }] });
		return Response.json({ outcome: { kind: 'refused', code: 'invalidInput', message: 'no' }, v: 0 });
	}) as unknown as typeof globalThis.fetch;
	const bolt = createBolt({ actor: null, locale: 'en', fetch });
	expect(await bolt.get('jobs', 'j1')).toMatchObject({ revision: 3, title: 'live' });
	expect(await bolt.get('jobs', 'j1', undefined, { revision: 1 })).toMatchObject({ revision: 1, title: 'past' });
	expect(sent[1]!.body.reads![0]).toEqual({ m: 'get', a: ['jobs', 'j1', { revision: 1 }] });
	expect(sent[0]!.body.reads![0]).toEqual({ m: 'get', a: ['jobs', 'j1'] });
	await bolt.act('jobs.update', { target: 'j1', set: { title: 'x' } });
	expect(sent[2]!.body.observed).toEqual({ j1: 3 });
});
