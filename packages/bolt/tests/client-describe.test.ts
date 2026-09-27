// `$bolt.describe` (rule 16a): present only when the host binds the AI facility, it posts `filter.describe` and returns
// the decoded `{ where, orderBy? }`; a refusal rejects, so the view popover says it could not build a filter.
import { expect, it } from 'vitest';
import { createBolt } from '../src/client/bolt.ts';

it('describe exists only with the AI facility and returns the committed where/orderBy', async () => {
	const sent: unknown[] = [];
	let reply: unknown = { outcome: { kind: 'committed', output: { where: { status: { eq: 'open' } }, orderBy: { created_at: 'desc' } }, records: [] }, v: 0 };
	const fetch = (async (_url: string, init: { body: string }) => { sent.push(JSON.parse(init.body)); return Response.json(reply); }) as unknown as typeof globalThis.fetch;
	expect(createBolt({ actor: null, locale: 'en', fetch }).describe).toBeUndefined();
	const bolt = createBolt({ actor: null, locale: 'en', fetch, describe: true });
	expect(await bolt.describe!('jobs', 'open jobs, newest first')).toEqual({ where: { status: { eq: 'open' } }, orderBy: { created_at: 'desc' } });
	expect(sent[0]).toMatchObject({ callable: 'filter.describe', input: { collection: 'jobs', text: 'open jobs, newest first' } });
	reply = { outcome: { kind: 'refused', code: 'invalidInput', message: 'Could not build a filter from that description.' }, v: 0 };
	await expect(bolt.describe!('jobs', 'x')).rejects.toThrow('Could not build a filter');
});
