// `$search` and `$similar` as predicates (rule 16): a row's search document holds every word of the text (prefixes and
// slipped spellings), or it is among the `top` nearest in meaning. Both nest under a relation like any condition, and
// both refuse a caller who does not read every field they cover unmasked (rule 14).
import { describe, expect, it } from 'vitest';
import type { EmbeddingsPort, EngineManifest, Outcome } from '../src/engine/contracts.ts';
import { embedRun } from '../src/engine/integrations/embed.ts';
import { respondSystem1, testWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		sites: { description: 'A site', label: 'name', fields: { name: { kind: 'text' }, address: { kind: 'text' } }, search: { text: ['name', 'address'] } },
		jobs: { description: 'A job', label: 'title', fields: { title: { kind: 'text' }, notes: { kind: 'text', optional: true } },
			search: { text: ['title', 'notes'], semantic: { fields: ['title'], model: 'small', dim: 3 } } },
	},
	relationships: { 'jobs.site': { to: 'sites', inverse: 'jobs' } },
	collections: {
		sites: { read: { fields: 'all' }, create: { input: { columns: ['name', 'address'] } } },
		jobs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'notes', 'site'] } } },
	},
	// `notes` is masked to the dispatcher: its one jobs arm lists the fields it reads
	policies: { dispatch: { description: 'Dispatch', grants: { sites: { read: true }, jobs: { read: { fields: ['id', 'title', 'site', 'created_at', 'updated_at'] } } } } },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

const created = (o: Outcome) => { if (o.kind !== 'committed') throw new Error(JSON.stringify(o)); return o.records[0]!.id; };
const near: { [text: string]: number[] } = { 'water leak': [1, 0, 0], 'burst pipe': [0.95, 0.05, 0], 'roof drip': [0.8, 0.2, 0], 'paint wall': [0, 0, 1], 'door hinge': [0, 1, 0] };
const embed: EmbeddingsPort['embed'] = async (inputs) => (inputs as string[]).map((x) => near[x] ?? [0, 0.5, 0.5]);

async function workspace() {
	const t = await testWorkspace({ manifest, ai: { sys_1: respondSystem1, sys_2: { models: ['default'], infer: async () => { throw new Error('unused'); } }, embed } });
	const a = t.as(t.admin);
	const pine = created(await a.act('sites.create', { name: '1F Pine Grove', address: '3 Ridgewood Close' }));
	const vale = created(await a.act('sites.create', { name: 'Sunset Vale', address: '12 Jalan Bukit' }));
	for (const [title, site, notes] of [['burst pipe', pine, 'Kitchen sink'], ['roof drip', vale, null], ['paint wall', pine, null], ['door hinge', vale, 'secret code 1234']] as const)
		await a.act('jobs.create', { title, site, ...(notes === null ? {} : { notes }) });
	await embedRun(t.manifest, t.db, { embed })({});
	const titles = async (where: object, who = a) => (await who.read('jobs', { all: true, where, select: { title: true } } as never)).rows.map((r) => r['title']).sort();
	return { t, titles, dispatcher: t.as(t.member(['dispatch'])) };
}

describe('$search and $similar (rule 16)', () => {
	it('$search: every word, each a prefix or a slipped spelling, over every searched field', async () => {
		const { titles } = await workspace();
		expect(await titles({ $search: 'pipe' })).toEqual(['burst pipe']);
		expect(await titles({ $search: 'kitchen pipe' })).toEqual(['burst pipe']); // a word in notes, a word in title
		expect(await titles({ $search: 'brust pipe' })).toEqual(['burst pipe']); // a slipped spelling
		expect(await titles({ $search: 'pipe paint' })).toEqual([]); // every word, not any
	});

	it('nests under a relation and composes with other conditions', async () => {
		const { titles } = await workspace();
		expect(await titles({ site: { is: { $search: 'pine grove' } } })).toEqual(['burst pipe', 'paint wall']);
		expect(await titles({ site: { is: { $search: 'ridgewood' } }, title: { like: '%paint%' } })).toEqual(['paint wall']);
		expect(await titles({ not: { site: { is: { $search: "sunset vale's" } } } })).toEqual(['burst pipe', 'paint wall']);
	});

	it('$similar: the nearest in meaning and every row nearly as near, at most top, embedded once before the read', async () => {
		const { titles } = await workspace();
		// door hinge and paint wall are far from the nearest: outside the band, though top would admit them
		expect(await titles({ $similar: 'water leak' })).toEqual(['burst pipe', 'roof drip']);
		expect(await titles({ $similar: { to: 'water leak', top: 1 } })).toEqual(['burst pipe']);
		expect(await titles({ $similar: { to: 'water leak', top: 2 }, site: { is: { $search: 'vale' } } })).toEqual(['roof drip']);
	});

	it('refuses a collection without the index and a caller who does not read every covered field unmasked', async () => {
		const { titles, dispatcher } = await workspace();
		await expect(titles({ site: { is: { $similar: 'x' } } })).rejects.toThrow(/declares no search.semantic/);
		await expect(titles({ $search: '' })).rejects.toThrow(/1–500 characters/);
		// `notes` is in jobs' search document: searching it would reveal "secret code" to a caller it is masked to
		await expect(titles({ $search: 'secret' }, dispatcher)).rejects.toThrow(/covers 'notes'/);
		expect(await titles({ $similar: { to: 'water leak', top: 1 } }, dispatcher)).toEqual(['burst pipe']); // the embedding covers title only
		expect(await titles({ site: { is: { $search: 'pine' } } }, dispatcher)).toEqual(['burst pipe', 'paint wall']);
	});
});
