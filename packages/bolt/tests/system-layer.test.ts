/// <reference types="node" />
// The built-in layer (`src/system/**`, owner rule 2026-09-26): bolt's own models, relationships and collections are
// declared as a workspace's are, discovered and loaded by the same compiler, merged into every workspace's schema plan,
// catalogue and names, and reserved against a workspace. The parity table below is today's hand DDL (the retired
// `engine/schema/system.ts` and the areas' `*_DDL` strings) as the planner must render it.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discover } from '../src/compiler/discover.ts';
import { load, manifestErrors, type Manifest } from '../src/compiler/load.ts';
import { systemIndex } from '../src/compiler/names.ts';
import type { EngineManifest } from '../src/engine/contracts.ts';
import { RANK, schemaObjects } from '../src/engine/schema/ddl.ts';
import { engineObjects } from '../src/engine/schema/engine.ts';
import { plan, schemaSlice } from '../src/engine/schema/plan.ts';
import { catalog } from '../src/protocol/catalog.ts';
import { SYSTEM } from '../src/system/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EMPTY = { workspace: { tz: 'UTC', locale: 'en' }, models: {}, relationships: {}, collections: {}, integrations: {}, pipelines: {}, policies: {},
	teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} } } as unknown as EngineManifest;

type Shape = { key: string; columns: { [column: string]: string }; unique?: readonly string[]; indexes?: readonly string[]; fks?: readonly string[]; checks?: readonly string[] };
/** A system table as the planner renders it: its key, each column's type, NOT NULL and default, and its constraints and indexes. */
function rendered(): { [table: string]: Shape } {
	const out: { [table: string]: Required<Shape> & { unique: string[]; indexes: string[]; fks: string[]; checks: string[] } } = {};
	const bare = (s: string) => s.replaceAll('"', '');
	const lit = (d: string) => d.replace(/^'(.*)'::\w+$/, '$1').replace(/^\((.*)\)$/, '$1');
	for (const o of schemaObjects(schemaSlice(EMPTY)).sort((a, b) => RANK[a.rank] - RANK[b.rank])) {
		if (!Object.hasOwn(SYSTEM.models, o.table)) continue;
		const t = (out[o.table] ??= { key: '', columns: {}, unique: [], indexes: [], fks: [], checks: [] });
		for (const sql of o.create) {
			let m = /^create table "\w+" \((.*)\)$/.exec(sql);
			if (m) { t.key = bare(m[1]!); continue; }
			m = /^alter table "\w+" add column "(\w+)" (.*)$/.exec(sql);
			if (m) { const d = / default (.*)$/.exec(m[2]!); t.columns[m[1]!] = d === null ? bare(m[2]!) : `${m[2]!.slice(0, d.index)} default ${lit(d[1]!)}`; continue; }
			m = /^alter table "\w+" alter column "(\w+)" set not null$/.exec(sql);
			if (m) { const c = t.columns[m[1]!]!, d = c.indexOf(' default '); t.columns[m[1]!] = d < 0 ? `${c} not null` : `${c.slice(0, d)} not null${c.slice(d)}`; continue; }
			if (/ set default /.test(sql)) continue;
			m = /^alter table "\w+" add constraint "\w+" (.*)$/.exec(sql);
			if (m) {
				const d = bare(m[1]!);
				if (d.startsWith('unique ')) t.unique.push(d.slice(7)); else if (d.startsWith('foreign key ')) t.fks.push(d.slice(12)); else t.checks.push(d.replace(/^check /, ''));
				continue;
			}
			m = /^create (unique )?index "\w+" on "\w+" (.*)$/.exec(sql);
			if (m) { (m[1] === undefined ? t.indexes : t.unique).push(bare(m[2]!)); continue; }
			throw new Error(`unparsed: ${sql}`);
		}
	}
	return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { key: v.key, columns: v.columns,
		...(['unique', 'indexes', 'fks', 'checks'] as const).reduce((a, x) => (v[x].length === 0 ? a : { ...a, [x]: [...v[x]].sort() }), {}) }]));
}

// Today's hand DDL, table by table. Differences the model language makes, each deliberate: a relationship's FK column gets
// its own index (`(team)`, `(parent)`, …); `sys_user.email` declares `format: 'email'`, so it gains the format CHECK and the
// query compiler folds its case as it always did for the catalogue's `email` fields; `sys_user_admin_staff` is the model
// `check` (two-valued: equal on these NOT NULL columns); `sys_notification (member, at DESC)` is `(member, at)`, which the
// same index serves backwards; an inline `REFERENCES`/`UNIQUE`/`CHECK` is a named constraint; `sys_conversation.paused` is
// gone with the envoy take-over it served (nothing sets or reads it).
const TODAY: { [table: string]: Shape } = {
	sys_team: { key: 'id text primary key', columns: { name: 'text not null', revision: 'int not null default 1', parent: 'text' },
		unique: ['(lower(name))'], indexes: ['(parent)'], fks: ['(parent) references sys_team (id)'] },
	sys_user: { key: 'id text primary key',
		columns: { email: 'text', name: 'text not null', kind: 'text not null default staff', active: 'boolean not null default true', admin: 'boolean not null default false',
			party: 'jsonb', party_id: "text generated always as (((party ->> 'id'))::text) stored", phone: 'text', telegram: 'text', revision: 'int not null default 1',
			phone_key: "text generated always as ((regexp_replace(phone, '\\D', '', 'g'))::text) stored",
			created_at: 'timestamptz not null default now()', team: 'text' },
		unique: ['(lower(email))', '(phone_key)'], indexes: ['(team)'], fks: ['(team) references sys_team (id)'],
		checks: ["((((coalesce(admin = false, false)) or (coalesce(kind = 'staff'::text, false)))))", "(email ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')", "(kind in ('staff', 'external'))"] },
	sys_api_key: { key: 'id text primary key',
		columns: { name: 'text not null', prefix: 'text not null', hash: 'text not null', created_by: 'text', revoked_at: 'timestamptz', last_used_at: 'timestamptz',
			revision: 'int not null default 1', created_at: 'timestamptz not null default now()' },
		unique: ['(prefix)'], indexes: ['(created_by)'], fks: ['(created_by) references sys_user (id)'] },
	sys_assignment: { key: 'id text primary key',
		columns: { principal_type: 'text not null', principal: 'text not null', policy: 'text not null', scope: 'jsonb', revision: 'int not null default 1' },
		indexes: ['(principal)'], checks: ["(principal_type in ('sys_user', 'sys_team', 'sys_api_key'))"] },
	sys_invitation: { key: 'id text primary key',
		columns: { email: 'text', phone: 'text', team: 'text', assignments: 'jsonb not null default []', external: 'boolean not null default false', party: 'jsonb',
			invited_by: 'text', expires_at: 'timestamptz not null', accepted_at: 'timestamptz', revoked_at: 'timestamptz', revision: 'int not null default 1' },
		indexes: ['(invited_by)', '(lower(email))', '(phone)', '(team)'], fks: ['(invited_by) references sys_user (id)', '(team) references sys_team (id)'],
		checks: ['((((email is not null) or (phone is not null))))'] },
	sys_session: { key: 'id text primary key',
		columns: { user: 'text not null', token_hash: 'text not null', via: 'text not null', impersonated_by: 'text', created_at: 'timestamptz not null',
			expires_at: 'timestamptz not null', refreshed_at: 'timestamptz not null' },
		unique: ['(token_hash)'], indexes: ['(impersonated_by)', '(user)'],
		fks: ['(impersonated_by) references sys_user (id)', '(user) references sys_user (id) on delete cascade'], checks: ["(via in ('code', 'invitation', 'signup', 'host'))"] },
	sys_challenge: { key: 'address_mac text primary key', columns: { code_mac: 'text not null', attempts: 'int not null default 0', expires_at: 'timestamptz not null' } },
	sys_config: { key: 'key text primary key', columns: { value: 'text not null' } },
	sys_run: { key: 'id text primary key',
		columns: { automation: 'text not null', input: 'jsonb not null', due_at: 'timestamptz not null', key: 'text', cause: 'text not null', depth: 'int not null',
			state: 'text not null default queued', attempts: 'int not null default 0', leases: 'int not null default 0', run_key: 'text', started_at: 'timestamptz',
			finished_at: 'timestamptz', progress: 'jsonb', output: 'jsonb', error: 'jsonb', results: 'jsonb not null default []', actor: 'text', starter: 'jsonb' },
		unique: ['(key)'], indexes: ["(due_at) where (state = 'queued'::text)"] },
	sys_notification: { key: 'id text primary key',
		columns: { recipient: 'jsonb not null', title: 'text not null', body: 'text', link: 'jsonb', once: 'text', at: 'timestamptz not null', member: 'text', read_at: 'timestamptz' },
		unique: ['(once)'], indexes: ['(member, at) where (member is not null)'] },
	sys_event: { key: 'id bigint generated always as identity primary key',
		columns: { at: 'timestamptz not null', severity: 'text not null', event: 'text not null', invocation: 'text not null', run: 'text', conversation: 'text',
			turn: 'text', attributes: 'jsonb not null' } },
	sys_file: { key: 'id text primary key',
		columns: { name: 'text not null', mime: 'text not null', size: 'int not null', key: 'text not null', sha256: 'text not null', field: 'text not null',
			revision: 'int not null default 1', approval_id: 'text', created_at: 'timestamptz not null', created_by: 'text', updated_at: 'timestamptz', updated_by: 'text' } },
	sys_conversation: { key: 'id text primary key',
		columns: { created_at: 'timestamptz not null default now()', title: 'text', owner: 'text', envoy: 'text', channel: 'text', thread: 'text', kind: 'text', participants: 'jsonb', parent: 'text',
			status: 'text not null default idle', lease_until: 'timestamptz', model: 'text not null default default',
			plan: 'jsonb', goals: 'jsonb', read: 'jsonb not null default {}', revision: 'int not null default 1', updated_at: 'timestamptz not null default now()' } },
	sys_message: { key: 'id text primary key',
		columns: { created_at: 'timestamptz not null default now()', conversation: 'text', seq: 'bigint generated by default as identity', role: 'text', content: 'jsonb',
			preview: 'text', text: 'text', state: 'text', mode: 'text', as: 'jsonb', author: 'text', meta: 'jsonb', supersedes: 'text', turn: 'text', read_by: 'text',
			delivered_turn: 'text', ambient: 'boolean not null default false', about: 'jsonb', channel: 'text', direction: 'text', origin: 'text', provider_id: 'text',
			version: 'text', sender: 'text', sender_name: 'text', sent_at: 'timestamptz', invocation: 'text', addressed: 'boolean', refused: 'text', email: 'jsonb',
			files: 'jsonb not null default []', reply_to: 'text', deleted_at: 'timestamptz', edited_at: 'timestamptz', status: 'text', attempts: 'int not null default 0',
			next_attempt_at: 'timestamptz', claimed_at: 'timestamptz', error: 'text', record: 'jsonb', rule: 'text', message: 'jsonb', thread: 'text', epoch: 'text',
			delivery: 'jsonb not null default []', presume_at: 'timestamptz' },
		indexes: ["(conversation) where (state = 'pending'::text)", "(conversation) where (state = 'queued'::text)", '(conversation, seq)', '(channel, provider_id)',
			"(seq) where (status in ('queued'::text, 'sending'::text))"] },
	approval_request: { key: 'id uuid primary key',
		columns: { collection_name: 'text not null', record_id: 'text not null', action: 'text not null', status: 'text not null', step: 'int not null', steps: 'int not null',
			approver_teams: 'jsonb not null', superseder_teams: 'jsonb not null', applied_at: 'timestamptz', closed_at: 'timestamptz', closed_by: 'text',
			revision: 'int not null default 1', created_at: 'timestamptz not null' },
		unique: ["(collection_name, record_id) where (status = 'ONGOING'::text)"] },
	requestor: { key: 'id text primary key', columns: { approval_request_id: 'uuid not null', user_id: 'text not null' },
		indexes: ['(approval_request_id)'], fks: ['(approval_request_id) references approval_request (id)'] },
};

describe('the built-in layer is compiled as a workspace is', () => {
	it('src/system/index.ts is the systemIndex of the discovered paths, and loading them gives SYSTEM', async () => {
		const { files, errors } = discover(ROOT, 'system');
		expect(errors).toEqual([]);
		expect(systemIndex(files)).toBe(readFileSync(join(ROOT, 'src/system/index.ts'), 'utf8'));
		const loaded = await load(ROOT, files, 'system');
		expect(loaded.errors).toEqual([]);
		const spec = (d: unknown) => (d as { spec?: unknown }).spec ?? d;
		expect(JSON.parse(JSON.stringify({ models: loaded.manifest.model, relationships: loaded.manifest.relationship[''],
			collections: Object.fromEntries(Object.entries(loaded.manifest.collection).map(([k, v]) => [k, spec(v)])) }))).toEqual(JSON.parse(JSON.stringify(SYSTEM)));
	});

	it('every system collection has its model, and the private models (sessions, challenges, config) are no collection', () => {
		for (const c of Object.keys(SYSTEM.collections)) expect(SYSTEM.models[c]).toBeDefined();
		expect(Object.keys(SYSTEM.models).filter((m) => !Object.hasOwn(SYSTEM.collections, m)).sort()).toEqual(['sys_challenge', 'sys_config', 'sys_session']);
	});
});

describe('the schema plan renders each system table as today\'s hand DDL did (L-BOLT-100 withdrawn)', () => {
	const now = rendered();
	it('renders exactly the system tables', () => expect(Object.keys(now).sort()).toEqual(Object.keys(TODAY).sort()));
	for (const [table, shape] of Object.entries(TODAY)) it(table, () => {
		const sorted = Object.fromEntries((['unique', 'indexes', 'fks', 'checks'] as const).flatMap((x) => (shape[x] === undefined ? [] : [[x, [...shape[x]!].sort()]])));
		expect(now[table]).toEqual({ ...shape, ...sorted });
	});

	it('the empty-database plan creates the layer\'s tables and the engine\'s private objects; the same slice plans no step', () => {
		const p = plan(null, EMPTY);
		for (const t of Object.keys(SYSTEM.models)) expect(p.steps.some((s) => s.id === `create:table:${t}`)).toBe(true);
		expect(p.steps.filter((s) => s.id.startsWith('create:engine:'))).toHaveLength(engineObjects().length);
		expect(plan(p.slice, EMPTY).steps).toEqual([]);
	});

	it('an FK to a system table takes its key type: text to sys_user, uuid to approval_request; a workspace model uuid', () => {
		const m = { ...EMPTY, models: { notes: { description: 'n', label: 'body', fields: { body: { kind: 'text' } } } },
			relationships: { 'notes.owner': { to: 'sys_user' }, 'notes.request': { to: 'approval_request', optional: true }, 'notes.parent': { to: 'notes', optional: true } } } as unknown as EngineManifest;
		const col = (c: string) => schemaObjects(schemaSlice(m)).find((o) => o.id === `column:notes.${c}`)!.create[0];
		expect([col('owner'), col('request'), col('parent')]).toEqual(['alter table "notes" add column "owner" text', 'alter table "notes" add column "request" uuid',
			'alter table "notes" add column "parent" uuid']);
	});

	it('a system table has no engine columns or approval index, and its uniques are plain (an on-conflict arbiter)', () => {
		const run = schemaObjects(schemaSlice(EMPTY)).filter((o) => o.table === 'sys_run');
		expect(run.some((o) => o.id.includes('__approval__'))).toBe(false);
		expect(run.flatMap((o) => o.create).filter((s) => s.includes('deferrable'))).toEqual([]);
	});
});

describe('the catalogue reads the system collections from their declarations', () => {
	const cat = catalog(EMPTY);
	it('exposes every system collection with its declared fields and relationships', () => {
		expect([...cat.collections.keys()].sort()).toEqual(Object.keys(SYSTEM.collections).sort());
		const user = cat.models.get('sys_user')!;
		expect(user.fields.get('email')).toMatchObject({ email: true, pg: 'text' });
		expect(user.fields.get('id')).toMatchObject({ pg: 'text' });
		expect(user.fields.has('approval_id')).toBe(false);
		expect(user.one.get('team')).toEqual({ name: 'team', targets: ['sys_team'] });
		expect(cat.models.get('approval_request')!.fields.get('id')).toMatchObject({ pg: 'uuid' });
		expect(cat.collections.get('sys_api_key')!.fields).toEqual(new Set(['name', 'prefix', 'created_by', 'revoked_at', 'last_used_at', 'revision', 'created_at']));
	});
});

describe('a workspace cannot reach into the built-in layer', () => {
	const workspace = (files: { [path: string]: string }) => {
		const root = mkdtempSync(join(tmpdir(), 'bolt-system-'));
		for (const [path, text] of Object.entries({ 'src/+workspace.ts': 'export default {};', ...files })) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), text);
		}
		try { return discover(root).errors.map((e) => `${e.code} ${e.path}`); } finally { rmSync(root, { recursive: true, force: true }); }
	};
	it('refuses a model or collection named as the layer\'s (sys_*, bolt_*, approval_request, requestor): discover/reserved-name', () => {
		expect(workspace({ 'src/data/model/sys_user/+model.ts': '', 'src/data/model/requestor/+model.ts': '', 'src/data/model/bolt_x/+model.ts': '',
			'src/data/model/approval_request/+model.ts': '', 'src/data/model/orders/+model.ts': '' })).toEqual([
			'discover/reserved-name src/data/model/approval_request/+model.ts', 'discover/reserved-name src/data/model/bolt_x/+model.ts',
			'discover/reserved-name src/data/model/requestor/+model.ts', 'discover/reserved-name src/data/model/sys_user/+model.ts']);
	});
	it('refuses `table` on a workspace model and a relationship on a system model: load/system-only, load/system-owned', () => {
		const m = { model: { notes: { description: 'n', label: 'body', fields: { body: { kind: 'text' } }, table: { primary: 'text' } } },
			relationship: { '': { 'sys_user.favourite': { to: 'notes' }, 'notes.owner': { to: 'sys_user' } } } };
		const manifest = { ...Object.fromEntries(['workspace', 'collection', 'integration', 'pipeline', 'app', 'group', 'page'].map((r) => [r, {}])), ...m } as unknown as Manifest;
		expect(manifestErrors(manifest).map((e) => e.code)).toEqual(['load/system-only', 'load/system-owned']);
		expect(manifestErrors(manifest, 'system')).toEqual([]);
	});
});
