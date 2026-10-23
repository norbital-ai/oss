/// <reference types="node" />
// The built-in layer (`src/system/**`, owner rule 2026-09-26): bolt's own models, relationships and collections are
// declared as a workspace's are, discovered and loaded by the same compiler, merged into every workspace's schema plan,
// catalogue and names, and reserved against a workspace. The expectations below cover the native schema contract.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from '@effect/vitest';
import { discover } from '../src/compiler/discover.ts';
import { ROLES } from '../src/decl/layout.ts';
import { load, manifestErrors, type Manifest } from '../src/compiler/load.ts';
import { systemIndex } from '../src/compiler/names.ts';
import { Effect, FileSystem, Layer, Result, Schema } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { RANK, schemaObjects } from '../src/engine/schema/ddl.ts';
import { engineObjects } from '../src/engine/schema/engine.ts';
import { plan, schemaSlice } from '../src/engine/schema/plan.ts';
import { catalog } from '../src/protocol/catalog.ts';
import { decodeIdentity } from '../src/engine/write/pack.ts';
import { SYSTEM } from '../src/system/index.ts';
import { Port } from '../src/engine/port.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const EMPTY: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	collections: {},
	integrations: {},
	pipelines: {},
	policies: {},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};

type Shape = {
	key: string;
	columns: { [column: string]: string };
	unique?: readonly string[];
	indexes?: readonly string[];
	fks?: readonly string[];
	checks?: readonly string[];
};
/** A system table as the planner renders it: its key, each column's type, NOT NULL and default, and its constraints and indexes. */
function rendered(): { [table: string]: Shape } {
	const out: {
		[table: string]: Required<Shape> & {
			unique: string[];
			indexes: string[];
			fks: string[];
			checks: string[];
		};
	} = {};
	const bare = (s: string) => s.replaceAll('"', '');
	const lit = (d: string) => d.replace(/^'(.*)'::\w+$/, '$1').replace(/^\((.*)\)$/, '$1');
	for (const o of schemaObjects(schemaSlice(EMPTY)).sort((a, b) => RANK[a.rank] - RANK[b.rank])) {
		if (!Object.hasOwn(SYSTEM.models, o.table) || o.id.startsWith('source:')) continue;
		const t = (out[o.table] ??= {
			key: '',
			columns: {},
			unique: [],
			indexes: [],
			fks: [],
			checks: []
		});
		for (const sql of o.create) {
			let m = /^create table "\w+" \((.*)\)$/.exec(sql);
			if (m) {
				t.key = bare(m[1]!);
				continue;
			}
			m = /^alter table "\w+" add column "(\w+)" (.*)$/.exec(sql);
			if (m) {
				const d = / default (.*)$/.exec(m[2]!);
				t.columns[m[1]!] =
					d === null ? bare(m[2]!) : `${m[2]!.slice(0, d.index)} default ${lit(d[1]!)}`;
				continue;
			}
			m = /^alter table "\w+" alter column "(\w+)" set not null$/.exec(sql);
			if (m) {
				const c = t.columns[m[1]!]!,
					d = c.indexOf(' default ');
				t.columns[m[1]!] = d < 0 ? `${c} not null` : `${c.slice(0, d)} not null${c.slice(d)}`;
				continue;
			}
			if (/ set default /.test(sql)) continue;
			m = /^alter table "\w+" add constraint "\w+" (.*)$/.exec(sql);
			if (m) {
				const d = bare(m[1]!);
				if (d.startsWith('unique ')) t.unique.push(d.slice(7));
				else if (d.startsWith('foreign key ')) t.fks.push(d.slice(12));
				else t.checks.push(d.replace(/^check /, ''));
				continue;
			}
			m = /^create (unique )?index "\w+" on "\w+" (.*)$/.exec(sql);
			if (m) {
				(m[1] === undefined ? t.indexes : t.unique).push(bare(m[2]!));
				continue;
			}
			throw new Error(`unparsed: ${sql}`);
		}
	}
	return Object.fromEntries(
		Object.entries(out).map(([k, v]) => [
			k,
			{
				key: v.key,
				columns: v.columns,
				...(['unique', 'indexes', 'fks', 'checks'] as const).reduce(
					(a, x) => (v[x].length === 0 ? a : { ...a, [x]: [...v[x]].sort() }),
					{}
				)
			}
		])
	);
}

// Native schema expectations include relationship indexes; teams are source, so `team` is plain text with no key.
const EXPECTED: { [table: string]: Shape } = {
	sys_user: {
		key: 'id text primary key',
		columns: {
			email: 'text',
			name: 'text not null',
			kind: 'text not null default staff',
			active: 'boolean not null default true',
			admin: 'boolean not null default false',
			signup: 'boolean not null default false',
			party: 'jsonb',
			party_id: "text generated always as (((party ->> 'id'))::text) stored",
			phone: 'text',
			telegram: 'text',
			revision: 'int not null default 1',
			phone_key: "text generated always as ((regexp_replace(phone, '\\D', '', 'g'))::text) stored",
			created_at: 'timestamptz not null default now()',
			team: 'text'
		},
		unique: ['(lower(email))', '(phone_key)'],
		checks: [
			"((coalesce(admin = false, false) or coalesce(kind = 'staff'::text, false)))",
			"(email ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')",
			"(kind in ('staff', 'external'))"
		]
	},
	sys_integration: {
		key: 'id text primary key',
		columns: {
			integration: 'text not null',
			name: 'text not null',
			named: 'boolean not null default false',
			envoy: 'text',
			active: 'boolean not null default true',
			configuration: 'jsonb not null default {}',
			import_start: 'jsonb',
			status: 'jsonb',
			epoch: 'text',
			revision: 'int not null default 1',
			owner: 'text'
		},
		indexes: ['(owner)'],
		unique: ['(owner, integration) where (owner is not null)'],
		fks: ['(owner) references sys_user (id)']
	},
	sys_api_key: {
		key: 'id text primary key',
		columns: {
			name: 'text not null',
			prefix: 'text not null',
			hash: 'text not null',
			created_by: 'text',
			revoked_at: 'timestamptz',
			last_used_at: 'timestamptz',
			revision: 'int not null default 1',
			created_at: 'timestamptz not null default now()',
			team: 'text'
		},
		unique: ['(prefix)'],
		indexes: ['(created_by)'],
		fks: ['(created_by) references sys_user (id)']
	},
	sys_invitation: {
		key: 'id text primary key',
		columns: {
			email: 'text',
			phone: 'text',
			team: 'text',
			external: 'boolean not null default false',
			party: 'jsonb',
			invited_by: 'text',
			expires_at: 'timestamptz not null',
			accepted_at: 'timestamptz',
			revoked_at: 'timestamptz',
			revision: 'int not null default 1'
		},
		indexes: ['(invited_by)', '(lower(email))', '(phone)'],
		fks: ['(invited_by) references sys_user (id)'],
		checks: ['((email is not null or phone is not null))']
	},
	sys_session: {
		key: 'id text primary key',
		columns: {
			user: 'text not null',
			token_hash: 'text not null',
			via: 'text not null',
			impersonated_by: 'text',
			created_at: 'timestamptz not null',
			expires_at: 'timestamptz not null',
			refreshed_at: 'timestamptz not null'
		},
		unique: ['(token_hash)'],
		indexes: ['(impersonated_by)', '(user)'],
		fks: [
			'(impersonated_by) references sys_user (id)',
			'(user) references sys_user (id) on delete cascade'
		],
		checks: ["(via in ('code', 'invitation', 'signup', 'host'))"]
	},
	sys_challenge: {
		key: 'address_mac text primary key',
		columns: {
			code_mac: 'text not null',
			attempts: 'int not null default 0',
			expires_at: 'timestamptz not null'
		}
	},
	sys_config: { key: 'key text primary key', columns: { value: 'text not null' } },
	sys_run: {
		key: 'id text primary key',
		columns: {
			automation: 'text not null',
			input: 'jsonb not null',
			due_at: 'timestamptz not null',
			key: 'text',
			cause: 'text not null',
			depth: 'int not null',
			state: 'text not null default queued',
			attempts: 'int not null default 0',
			leases: 'int not null default 0',
			run_key: 'text',
			started_at: 'timestamptz',
			finished_at: 'timestamptz',
			progress: 'jsonb',
			output: 'jsonb',
			error: 'jsonb',
			results: 'jsonb not null default []',
			actor: 'text',
			starter: 'jsonb'
		},
		unique: ['(key)'],
		indexes: ["(due_at) where (state = 'queued'::text)"]
	},
	sys_notification: {
		key: 'id text primary key',
		columns: {
			recipient: 'jsonb not null',
			title: 'text not null',
			body: 'text',
			link: 'jsonb',
			once: 'text',
			at: 'timestamptz not null',
			member: 'text',
			read_at: 'timestamptz'
		},
		unique: ['(once)'],
		indexes: ['(member, at) where (member is not null)']
	},
	sys_file: {
		key: 'id text primary key',
		columns: {
			name: 'text not null',
			mime: 'text not null',
			size: 'int not null',
			key: 'text not null',
			sha256: 'text not null',
			field: 'text not null',
			revision: 'int not null default 1',
			created_at: 'timestamptz not null',
			created_by: 'text',
			updated_at: 'timestamptz',
			updated_by: 'text'
		}
	},
	sys_conversation: {
		key: 'id text primary key',
		columns: {
			created_at: 'timestamptz not null default now()',
			title: 'text',
			owner: 'text',
			envoy: 'text',
			thread: 'text',
			kind: 'text',
			participants: 'jsonb',
			parent: 'text',
			run: 'text',
			inputs: 'jsonb not null default []',
			outputs: 'jsonb not null default []',
			status: 'text not null default idle',
			lease_until: 'timestamptz',
			model: 'text not null default default',
			plan: 'jsonb',
			goals: 'jsonb',
			read: 'jsonb not null default {}',
			revision: 'int not null default 1',
			updated_at: 'timestamptz not null default now()',
			integration: 'text'
		},
		indexes: ['(integration)'],
		fks: ['(integration) references sys_integration (id) on delete cascade']
	},
	sys_message: {
		key: 'id text primary key',
		columns: {
			created_at: 'timestamptz not null default now()',
			conversation: 'text',
			seq: 'bigint generated by default as identity',
			role: 'text',
			content: 'jsonb',
			preview: 'text',
			text: 'text',
			state: 'text',
			mode: 'text',
			as: 'jsonb',
			author: 'text',
			meta: 'jsonb',
			supersedes: 'text',
			turn: 'text',
			read_by: 'text',
			delivered_turn: 'text',
			about: 'jsonb',
			direction: 'text',
			origin: 'text',
			provider_id: 'text',
			version: 'text',
			sender: 'text',
			sender_name: 'text',
			sent_at: 'timestamptz',
			source_at: 'timestamptz',
			invocation: 'text',
			addressed: 'boolean',
			refused: 'text',
			email: 'jsonb',
			reply_to: 'text',
			deleted_at: 'timestamptz',
			edited_at: 'timestamptz',
			status: 'text',
			attempts: 'int not null default 0',
			next_attempt_at: 'timestamptz',
			claimed_at: 'timestamptz',
			error: 'text',
			record: 'jsonb',
			rule: 'text',
			key: 'text',
			hash: 'text',
			class: 'text',
			message: 'jsonb',
			thread: 'text',
			epoch: 'text',
			delivery: 'jsonb not null default []',
			presume_at: 'timestamptz',
			integration: 'text'
		},
		unique: ['(key)'],
		checks: ["(class in ('message', 'command'))"],
		indexes: [
			"(conversation) where (state = 'pending'::text)",
			"(conversation) where (state = 'queued'::text)",
			'(conversation, seq)',
			'(integration)',
			'(integration, provider_id)',
			"(seq) where (status in ('queued'::text, 'sending'::text))"
		],
		fks: ['(integration) references sys_integration (id) on delete cascade']
	},
	approval_request: {
		key: 'id uuid primary key',
		columns: {
			collection_name: 'text not null',
			record_id: 'text not null',
			action: 'text not null',
			status: 'text not null',
			step: 'int not null',
			steps: 'int not null',
			approver_teams: 'jsonb not null',
			superseder_teams: 'jsonb not null',
			closed_at: 'timestamptz',
			closed_by: 'text',
			revision: 'int not null default 1',
			created_at: 'timestamptz not null'
		},
		unique: ["(collection_name, record_id) where (status = 'ONGOING'::text)"]
	},
	requestor: {
		key: 'id text primary key',
		columns: { approval_request_id: 'uuid not null', user_id: 'text not null' },
		indexes: ['(approval_request_id)'],
		fks: ['(approval_request_id) references approval_request (id)']
	}
};

describe('the built-in layer is compiled as a workspace is', () => {
	it.effect(
		'src/system/index.ts is the systemIndex of the discovered paths, and loading them gives SYSTEM',
		() =>
			Effect.gen(function* () {
				const { files, errors } = yield* discover(ROOT, 'system');
				const fs = yield* FileSystem.FileSystem;
				expect(errors).toEqual([]);
				const file = join(ROOT, 'src/system/index.ts');
				const options = yield* Effect.tryPromise({
					try: () => resolveConfig(file),
					catch: Port.failure('fixture.format')
				}).pipe(Effect.orDie);
				const generated = yield* Effect.tryPromise({
					try: () => format(systemIndex(files), { ...options, filepath: file }),
					catch: Port.failure('fixture.format')
				}).pipe(Effect.orDie);
				expect(generated).toBe(yield* fs.readFileString(file));
				const loaded = yield* load(ROOT, files);
				expect(loaded.errors).toEqual([]);
				expect(manifestErrors(loaded.manifest, 'system')).toEqual([]);
				const spec = (d: unknown) => (d as { spec?: unknown }).spec ?? d;
				expect(
					JSON.parse(
						JSON.stringify({
							models: loaded.manifest.model,
							relationships: loaded.manifest.relationship[''],
							collections: Object.fromEntries(
								Object.entries(loaded.manifest.collection).map(([k, v]) => [k, spec(v)])
							),
							integrations: Object.fromEntries(
								Object.entries(loaded.manifest.integration_definition).map(([k, v]) => [k, spec(v)])
							)
						})
					)
				).toEqual(JSON.parse(JSON.stringify(SYSTEM)));
				// bolt's conversation definitions: one per conversation driver, each its driver's name
				expect(
					Object.entries(SYSTEM.integrations).map(([name, d]) => `${name}:${d.driver}`)
				).toEqual([
					'discord:discord',
					'email:email',
					'slack:slack',
					'telegram:telegram',
					'wechat:wechat',
					'whatsapp:whatsapp'
				]);
			}).pipe(Effect.provide(Platform))
	);

	it('every system collection has its model, and the private models (sessions, challenges, config) are no collection', () => {
		for (const c of Object.keys(SYSTEM.collections)) expect(SYSTEM.models[c]).toBeDefined();
		expect(
			Object.keys(SYSTEM.models)
				.filter((m) => !Object.hasOwn(SYSTEM.collections, m))
				.sort()
		).toEqual(['sys_challenge', 'sys_config', 'sys_session']);
	});
});

describe('the schema plan renders the built-in native contract', () => {
	const now = rendered();
	it('renders exactly the system tables', () =>
		expect(Object.keys(now).sort()).toEqual(Object.keys(EXPECTED).sort()));
	for (const [table, shape] of Object.entries(EXPECTED))
		it(table, () => {
			const sorted = Object.fromEntries(
				(['unique', 'indexes', 'fks', 'checks'] as const).flatMap((x) =>
					shape[x] === undefined ? [] : [[x, [...shape[x]!].sort()]]
				)
			);
			expect(now[table]).toEqual({ ...shape, ...sorted });
		});

	it("the empty-database plan creates the layer's tables and the engine's private objects; the same slice plans no step", () => {
		const p = plan(null, EMPTY);
		for (const t of Object.keys(SYSTEM.models))
			expect(p.steps.some((s) => s.id === `create:table:${t}`)).toBe(true);
		expect(p.steps.filter((s) => s.id.startsWith('create:engine:'))).toHaveLength(
			engineObjects().length
		);
		expect(plan(p.slice, EMPTY).steps).toEqual([]);
	});

	it('an FK to a system table takes its key type: text to sys_user, uuid to approval_request; a workspace model uuid', () => {
		const m: EngineManifest = {
			...EMPTY,
			models: { notes: { description: 'n', label: 'body', fields: { body: { kind: 'text' } } } },
			relationships: {
				'notes.owner': { to: 'sys_user' },
				'notes.request': { to: 'approval_request', optional: true },
				'notes.parent': { to: 'notes', optional: true }
			}
		};
		const col = (c: string) =>
			schemaObjects(schemaSlice(m)).find((o) => o.id === `column:notes.${c}`)!.create[0];
		expect([col('owner'), col('request'), col('parent')]).toEqual([
			'alter table "notes" add column "owner" text',
			'alter table "notes" add column "request" uuid',
			'alter table "notes" add column "parent" uuid'
		]);
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
		expect(user.one.has('team')).toBe(false);
		expect(user.fields.get('team')).toMatchObject({ kind: 'text', team: true, pg: 'text' });
		expect(cat.models.get('approval_request')!.fields.get('id')).toMatchObject({ pg: 'uuid' });
		expect(cat.collections.get('sys_api_key')!.fields).toEqual(
			new Set([
				'name',
				'prefix',
				'team',
				'created_by',
				'revoked_at',
				'last_used_at',
				'revision',
				'created_at'
			])
		);
	});
});

describe('a workspace cannot reach into the built-in layer', () => {
	const workspace = (files: { [path: string]: string }) =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const root = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-system-' });
				for (const [path, text] of Object.entries({
					'src/+workspace.ts': 'export default {};',
					...files
				})) {
					yield* fs.makeDirectory(dirname(join(root, path)), { recursive: true });
					yield* fs.writeFileString(join(root, path), text);
				}
				return (yield* discover(root)).errors.map((e) => `${e.code} ${e.path}`);
			})
		).pipe(Effect.provide(Platform));
	it.effect(
		"refuses a model or collection named as the layer's (sys_*, bolt_*, approval_request, requestor): discover/reserved-name",
		() =>
			Effect.gen(function* () {
				expect(
					yield* workspace({
						'src/data/model/+sys_user.model.ts': '',
						'src/data/model/+requestor.model.ts': '',
						'src/data/model/+bolt_x.model.ts': '',
						'src/data/model/+approval_request.model.ts': '',
						'src/data/model/+orders.model.ts': ''
					})
				).toEqual([
					'discover/reserved-name src/data/model/+approval_request.model.ts',
					'discover/reserved-name src/data/model/+bolt_x.model.ts',
					'discover/reserved-name src/data/model/+requestor.model.ts',
					'discover/reserved-name src/data/model/+sys_user.model.ts'
				]);
			})
	);
	it('refuses `table` on a workspace model and a relationship on a system model: load/system-only, load/system-owned', () => {
		const m = {
			model: {
				notes: {
					description: 'n',
					label: 'body',
					fields: { body: { kind: 'text' } },
					table: { primary: 'text' }
				}
			},
			relationship: {
				'': { 'sys_user.favourite': { to: 'notes' }, 'notes.owner': { to: 'sys_user' } }
			}
		};
		const manifest: Manifest = Schema.decodeUnknownSync(
			Schema.Record(
				Schema.Literals(ROLES.map(({ role }) => role)),
				Schema.Record(Schema.String, Schema.Unknown)
			)
		)({ ...Object.fromEntries(ROLES.map(({ role }) => [role, {}])), ...m });
		expect(manifestErrors(manifest).map((e) => e.code)).toEqual([
			'load/system-only',
			'load/system-owned'
		]);
		expect(manifestErrors(manifest, 'system')).toEqual([]);
	});
});

describe('a seed pack seeds run-time instances, never a connection', () => {
	const m: EngineManifest = { ...EMPTY, connections: { mail: { integration: 'email' } } };
	const decode = (row: { [field: string]: string | boolean }) => {
		return Result.match(
			Result.try({
				try: () => decodeIdentity(m, { sys_integration: [row] }),
				catch: (error) => (error instanceof Error ? error.message : String(error))
			}),
			{
				onSuccess: () => null,
				onFailure: (message) => message
			}
		);
	};
	it('admits an unnamed instance of a defined integration; refuses a slot, a named row, an envoy, an unknown definition and a row without an id', () => {
		const id = '0199a000-0000-7000-8000-000000000001';
		expect(
			decode({ id, integration: 'whatsapp', name: 'Sales line', owner: 'u1', active: false })
		).toBeNull();
		expect(decode({ id: 'mail', integration: 'email', name: 'Mail' })).toMatch(
			/'mail' is a connection of \+workspace\.ts/
		);
		expect(decode({ id, integration: 'whatsapp', name: 'x', named: true })).toMatch(
			/'named' is not seeded/
		);
		expect(decode({ id, integration: 'whatsapp', name: 'x', envoy: 'desk' })).toMatch(
			/'envoy' is not seeded/
		);
		expect(decode({ id, integration: 'kingdee', name: 'x' })).toMatch(
			/no integration 'kingdee' is defined/
		);
		expect(decode({ integration: 'whatsapp', name: 'x' })).toMatch(/every row carries its id/);
	});
	it("decodes a seeded configuration as a created instance's: its defaults filled, an invalid one refused", () => {
		const erp: EngineManifest = {
			...m,
			integrations: {
				erp: {
					description: 'ERP',
					driver: 'http',
					configuration: { region: { kind: 'text' }, lag: { kind: 'int', default: 15 } }
				}
			}
		};
		const id = '0199a000-0000-7000-8000-000000000001';
		expect(
			decodeIdentity(erp, {
				sys_integration: [
					{ id, integration: 'erp', name: 'Ledger', configuration: { region: 'sg' } }
				]
			})['sys_integration']
		).toEqual([
			{ id, integration: 'erp', name: 'Ledger', configuration: { lag: 15, region: 'sg' } }
		]);
		// a null is absent, so the default fills it: a body reads every defaulted field present, an optional one may be null
		const note: EngineManifest = {
			...erp,
			integrations: {
				erp: {
					...erp.integrations['erp']!,
					configuration: {
						lag: { kind: 'int', default: 15 },
						note: { kind: 'text', optional: true, default: 'x' }
					}
				}
			}
		};
		expect(
			decodeIdentity(note, {
				sys_integration: [
					{ id, integration: 'erp', name: 'Ledger', configuration: { lag: null, note: null } }
				]
			})['sys_integration']
		).toEqual([{ id, integration: 'erp', name: 'Ledger', configuration: { lag: 15, note: null } }]);
		expect(() =>
			decodeIdentity(erp, {
				sys_integration: [
					{ id, integration: 'erp', name: 'Ledger', configuration: { lag: 'soon' } }
				]
			})
		).toThrow(
			/sys_integration\[0\]: The configuration is invalid: region is required; lag Expected number \| null\./
		);
	});
});
