/// <reference types="node" />
// The built-in layer (`src/system/**`): bolt's own models, relationships and models are
// declared as a workspace's are, discovered and loaded by the same compiler, merged into every workspace's schema plan,
// catalogue and names, and reserved against a workspace. The expectations below cover the native schema contract.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import { discover } from '../../bolt-cli/src/compiler/discover.ts';
import { ROLES } from '../src/decl/layout.ts';
import { load, manifestErrors, spec, type Manifest } from '../../bolt-cli/src/compiler/load.ts';
import { split_system_model } from '../src/decl/model-data.ts';
import { Effect, FileSystem, Layer, Result, Schema } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { RANK, schema_objects, schema_snapshot } from '@norbital-ai/store';
import { engineObjects } from '../src/engine/schema/engine.ts';
import { plan, schema_slice } from '../src/engine/schema/plan.ts';
import { catalog } from '../src/protocol/catalog.ts';
import { decode_identity } from '../src/engine/write/pack.ts';
import { SYSTEM } from '../src/system/index.ts';
import { install } from '../src/decl/runtime/guest.ts';

// the fixtures' generator bodies attach through the guest edge, as `bolt check` installs it
install();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const EMPTY: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
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
const shape_lists: readonly (keyof Omit<Shape, 'key' | 'columns'>)[] = [
	'unique',
	'indexes',
	'fks',
	'checks'
];
const capture = (match: readonly string[], position: number): string => {
	const value = match[position];
	if (value === undefined)
		throw new Error(`Missing native SQL/source capture ${position}: ${match[0]}`);
	return value;
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
	const bare = (s: string) =>
		s.replaceAll('"', '').replace(/(bolt_record_label_\w+)_([0-9a-f]{8})/g, '$1_HASH');
	const lit = (d: string) => d.replace(/^'(.*)'::\w+$/, '$1').replace(/^\((.*)\)$/, '$1');
	for (const o of [...Effect.runSync(schema_objects(schema_slice(EMPTY)))].sort(
		(a, b) => RANK[a.rank] - RANK[b.rank]
	)) {
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
				t.key = bare(capture(m, 1));
				continue;
			}
			m = /^alter table "\w+" add column "?(\w+)"? (.*)$/.exec(sql);
			if (m) {
				const definition = capture(m, 2);
				const d = / default (.*)$/.exec(definition);
				t.columns[capture(m, 1)] =
					d === null
						? bare(definition)
						: `${definition.slice(0, d.index)} default ${lit(capture(d, 1))}`;
				continue;
			}
			m = /^alter table "\w+" alter column "(\w+)" set not null$/.exec(sql);
			if (m) {
				const column = capture(m, 1),
					c = t.columns[column];
				if (c === undefined) throw new Error(`NOT NULL precedes the native column: ${sql}`);
				const d = c.indexOf(' default ');
				t.columns[column] = d < 0 ? `${c} not null` : `${c.slice(0, d)} not null${c.slice(d)}`;
				continue;
			}
			if (/ set default /.test(sql)) continue;
			m = /^alter table "\w+" add constraint "\w+" (.*)$/.exec(sql);
			if (m) {
				const d = bare(capture(m, 1));
				if (d.startsWith('unique ')) t.unique.push(d.slice(7));
				else if (d.startsWith('foreign key ')) t.fks.push(d.slice(12));
				else t.checks.push(d.replace(/^check /, ''));
				continue;
			}
			// native row guards are their own contract (the trigger test below); this shape covers tables, columns and constraints
			if (/^(?:create|drop) trigger /.test(sql)) continue;
			// The label function's body is exercised by native label/search integration tests.
			if (/^create function "bolt_record_label_/.test(sql)) continue;
			m = /^create (unique )?index "\w+" on "\w+" (.*)$/.exec(sql);
			if (m) {
				(m[1] === undefined ? t.indexes : t.unique).push(bare(capture(m, 2)));
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
				...shape_lists.reduce(
					(a, x) => (v[x].length === 0 ? a : { ...a, [x]: [...v[x]].sort() }),
					{}
				)
			}
		])
	);
}

// Native schema expectations include relationship indexes; teams are source, so `team` is plain text with no key.
const EXPECTED: { [table: string]: Shape } = {
	approval_request: {
		key: 'id uuid primary key',
		columns: {
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(collection_name::text, ''))) stored",
			collection_name: 'text not null',
			record_id: 'text not null',
			action: 'text not null',
			status: 'text not null',
			step: 'int not null',
			steps: 'int not null',
			step_names: 'jsonb not null',
			approver_teams: 'jsonb not null',
			approver_users: 'jsonb not null',
			superseder_teams: 'jsonb not null',
			closed_at: 'timestamptz',
			closed_by: 'text',
			revision: 'int not null default 1',
			created_at: 'timestamptz not null'
		},
		unique: ["(collection_name, record_id) where (status = 'ONGOING'::text)"],
		indexes: ['using gin (bolt_search)'],
		checks: [
			"((approver_teams is null or store_json_valid(approver_teams, '{kind:json,shape:{kind:text,many:true}}'::jsonb) is true))",
			"((approver_users is null or store_json_valid(approver_users, '{kind:json,shape:{kind:text,many:true}}'::jsonb) is true))",
			"((step_names is null or store_json_valid(step_names, '{kind:json,shape:{kind:text,many:true}}'::jsonb) is true))",
			"((superseder_teams is null or store_json_valid(superseder_teams, '{kind:json,shape:{kind:text,many:true}}'::jsonb) is true))",
			"(action in ('create', 'update', 'delete'))",
			'(isfinite(closed_at))',
			'(isfinite(created_at))',
			"(status in ('ONGOING', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'WITHDRAWN'))"
		]
	},
	requestor: {
		key: 'id text primary key',
		columns: {
			user_id: 'text not null',
			approval_request_id: 'uuid not null',
			bolt_record_label:
				'text generated always as (bolt_record_label_requestor_HASH(user_id)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_requestor_HASH(user_id), ''))) stored"
		},
		indexes: ['(approval_request_id)', 'using gin (bolt_search)'],
		fks: [
			'(approval_request_id) references approval_request (id) on delete restrict on update restrict'
		]
	},
	sys_api_key: {
		key: 'id text primary key',
		columns: {
			name: 'text not null',
			prefix: 'text not null',
			hash: 'text not null',
			team: 'text',
			revoked_at: 'timestamptz',
			last_used_at: 'timestamptz',
			revision: 'int not null default 1',
			created_at: 'timestamptz not null default now()',
			created_by: 'text',
			bolt_record_label:
				'text generated always as (bolt_record_label_sys_api_key_HASH(name)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_api_key_HASH(name), ''))) stored"
		},
		unique: ['(prefix)'],
		indexes: ['(created_by)', 'using gin (bolt_search)'],
		fks: ['(created_by) references sys_user (id) on delete restrict on update restrict'],
		checks: ['(isfinite(created_at))', '(isfinite(last_used_at))', '(isfinite(revoked_at))']
	},
	sys_challenge: {
		key: 'address_mac text primary key',
		columns: {
			code_mac: 'text not null',
			attempts: 'int not null default 0',
			expires_at: 'timestamptz not null',
			bolt_record_label:
				'text generated always as (bolt_record_label_sys_challenge_HASH(address_mac)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_challenge_HASH(address_mac), ''))) stored"
		},
		indexes: ['using gin (bolt_search)'],
		checks: ['(isfinite(expires_at))']
	},
	sys_config: {
		key: 'key text primary key',
		columns: {
			value: 'text not null',
			bolt_record_label: 'text generated always as (bolt_record_label_sys_config_HASH(key)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_config_HASH(key), ''))) stored"
		},
		indexes: ['using gin (bolt_search)']
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
			restart_from: 'text',
			restart_at: 'text',
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
			integration: 'text',
			bolt_record_label:
				'text generated always as (bolt_record_label_sys_conversation_HASH(title)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_conversation_HASH(title), ''))) stored"
		},
		indexes: ['(integration)', 'using gin (bolt_search)'],
		fks: ['(integration) references sys_integration (id) on delete cascade on update restrict'],
		checks: [
			"((goals is null or store_json_valid(goals, '{kind:json,optional:true}'::jsonb) is true))",
			"((inputs is null or store_json_valid(inputs, '{default:[],kind:json}'::jsonb) is true))",
			"((outputs is null or store_json_valid(outputs, '{default:[],kind:json}'::jsonb) is true))",
			"((participants is null or store_json_valid(participants, '{kind:json,optional:true}'::jsonb) is true))",
			"((plan is null or store_json_valid(plan, '{kind:json,optional:true}'::jsonb) is true))",
			"((read is null or store_json_valid(read, '{default:{},kind:json}'::jsonb) is true))",
			'(isfinite(created_at))',
			'(isfinite(lease_until))',
			'(isfinite(updated_at))'
		]
	},
	sys_envoy: {
		key: 'id uuid primary key',
		columns: {
			name: 'text not null',
			audience: 'text not null default private',
			task: 'text not null default ',
			policies: "text[] not null default '{}'::text[]",
			group_messages: 'text not null default mention_or_reply',
			delegation: 'text not null default disabled',
			triage: 'boolean not null default false',
			triage_scope: 'text not null default all',
			dm: 'text not null default union',
			active: 'boolean not null default true',
			created_at: 'timestamptz not null default now()',
			revision: 'int not null default 1',
			bolt_record_label: 'text generated always as (bolt_record_label_sys_envoy_HASH(name)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_envoy_HASH(name), ''))) stored"
		},
		indexes: ['using gin (bolt_search)', 'using gin (policies)'],
		checks: [
			"(audience in ('private', 'public'))",
			"(delegation in ('enabled', 'disabled'))",
			"(dm in ('union', 'envoy'))",
			"(group_messages in ('disabled', 'mention_or_reply', 'all'))",
			'(isfinite(created_at))',
			"(not jsonb_path_exists(to_jsonb(policies), 'strict $[*] ? (@.type() != string)'))",
			"(triage_scope in ('dm', 'group', 'all'))"
		]
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
			updated_by: 'text',
			bolt_record_label: 'text generated always as (bolt_record_label_sys_file_HASH(name)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_file_HASH(name), ''))) stored"
		},
		indexes: ['using gin (bolt_search)'],
		checks: ['(isfinite(created_at))', '(isfinite(updated_at))']
	},
	sys_inbox: {
		key: 'id uuid primary key',
		columns: {
			sync: 'text not null',
			delivery: 'text not null',
			received_at: 'timestamptz not null',
			headers: 'jsonb',
			body: 'jsonb',
			consumed_at: 'timestamptz',
			instance: 'text not null',
			bolt_record_label:
				'text generated always as (bolt_record_label_sys_inbox_HASH(delivery)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_inbox_HASH(delivery), ''))) stored"
		},
		unique: ['nulls not distinct (sync, instance, delivery)'],
		indexes: [
			'(instance)',
			'(sync, instance, received_at) where (consumed_at is null)',
			'using gin (bolt_search)'
		],
		fks: ['(instance) references sys_integration (id) on delete cascade on update restrict'],
		checks: [
			"((body is null or store_json_valid(body, '{kind:json,optional:true}'::jsonb) is true))",
			"((headers is null or store_json_valid(headers, '{kind:json,optional:true}'::jsonb) is true))",
			'(isfinite(consumed_at))',
			'(isfinite(received_at))'
		]
	},
	sys_integration: {
		key: 'id text primary key',
		columns: {
			integration: 'text not null',
			name: 'text not null',
			envoy: 'text',
			active: 'boolean not null default true',
			configuration: 'jsonb not null default {}',
			import_start: 'jsonb',
			status: 'jsonb',
			epoch: 'text',
			revision: 'int not null default 1',
			updated_at: 'timestamptz not null default now()',
			owner: 'text',
			bolt_record_label:
				'text generated always as (bolt_record_label_sys_integration_HASH(name)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_integration_HASH(name), ''))) stored"
		},
		unique: ['(owner, integration) where (owner is not null)'],
		indexes: ['(owner)', 'using gin (bolt_search)'],
		fks: ['(owner) references sys_user (id) on delete restrict on update restrict'],
		checks: [
			"((configuration is null or store_json_valid(configuration, '{default:{},kind:json}'::jsonb) is true))",
			"((import_start is null or store_json_valid(import_start, '{kind:json,optional:true}'::jsonb) is true))",
			"((status is null or store_json_valid(status, '{kind:json,optional:true}'::jsonb) is true))",
			'(isfinite(updated_at))'
		]
	},
	sys_invitation: {
		key: 'id text primary key',
		columns: {
			email: 'text',
			phone: 'text',
			external: 'boolean not null default false',
			team: 'text',
			party: 'jsonb',
			expires_at: 'timestamptz not null',
			accepted_at: 'timestamptz',
			revoked_at: 'timestamptz',
			revision: 'int not null default 1',
			invited_by: 'text',
			bolt_record_label:
				'text generated always as (bolt_record_label_sys_invitation_HASH(email)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_invitation_HASH(email), ''))) stored"
		},
		indexes: ['(invited_by)', '(lower(email))', '(phone)', 'using gin (bolt_search)'],
		fks: ['(invited_by) references sys_user (id) on delete restrict on update restrict'],
		checks: [
			'((email is not null or phone is not null))',
			"((party is null or store_json_valid(party, '{kind:json,optional:true}'::jsonb) is true))",
			'(isfinite(accepted_at))',
			'(isfinite(expires_at))',
			'(isfinite(revoked_at))'
		]
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
			copied_from: 'text',
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
			message: 'jsonb',
			thread: 'text',
			epoch: 'text',
			delivery: 'jsonb not null default []',
			presume_at: 'timestamptz',
			integration: 'text',
			bolt_record_label:
				'text generated always as (bolt_record_label_sys_message_HASH(preview)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_message_HASH(preview), ''))) stored"
		},
		indexes: [
			"(conversation) where (state = 'pending'::text)",
			"(conversation) where (state = 'queued'::text)",
			'(conversation, seq)',
			'(integration)',
			'(integration, provider_id)',
			"(seq) where (status in ('queued'::text, 'sending'::text))",
			'using gin (bolt_search)'
		],
		fks: ['(integration) references sys_integration (id) on delete cascade on update restrict'],
		checks: [
			"((about is null or store_json_valid(about, '{kind:json,optional:true}'::jsonb) is true))",
			"((as is null or store_json_valid(as, '{kind:json,optional:true}'::jsonb) is true))",
			"((content is null or store_json_valid(content, '{kind:json,optional:true}'::jsonb) is true))",
			"((delivery is null or store_json_valid(delivery, '{default:[],kind:json}'::jsonb) is true))",
			"((email is null or store_json_valid(email, '{kind:json,optional:true}'::jsonb) is true))",
			"((message is null or store_json_valid(message, '{kind:json,optional:true}'::jsonb) is true))",
			"((meta is null or store_json_valid(meta, '{kind:json,optional:true}'::jsonb) is true))",
			'(isfinite(claimed_at))',
			'(isfinite(created_at))',
			'(isfinite(deleted_at))',
			'(isfinite(edited_at))',
			'(isfinite(next_attempt_at))',
			'(isfinite(presume_at))',
			'(isfinite(sent_at))',
			'(isfinite(source_at))'
		]
	},
	sys_notification: {
		key: 'id text primary key',
		columns: {
			recipient: 'jsonb not null',
			title: 'text not null',
			body: 'text',
			link: 'jsonb',
			attachments: 'jsonb not null default []',
			once: 'text',
			at: 'timestamptz not null',
			member: 'text',
			read_at: 'timestamptz',
			bolt_record_label:
				'text generated always as (bolt_record_label_sys_notification_HASH(title)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_notification_HASH(title), ''))) stored"
		},
		unique: ['(once)'],
		indexes: ['(member, at) where (member is not null)', 'using gin (bolt_search)'],
		checks: [
			"((attachments is null or store_json_valid(attachments, '{default:[],kind:json}'::jsonb) is true))",
			"((link is null or store_json_valid(link, '{kind:json,optional:true}'::jsonb) is true))",
			"((recipient is null or store_json_valid(recipient, '{kind:json}'::jsonb) is true))",
			'(isfinite(at))',
			'(isfinite(read_at))'
		]
	},
	sys_outbox: {
		key: 'id uuid primary key',
		columns: {
			seq: 'bigint generated by default as identity',
			sync: 'text not null',
			model: 'text not null',
			record: 'text not null',
			op: 'text not null',
			delivery_op: 'text',
			record_revision: 'int not null',
			preserve_local: 'boolean not null default false',
			image: 'jsonb',
			changed: 'jsonb not null default []',
			key: 'text not null',
			status: 'text not null default queued',
			attempts: 'int not null default 0',
			next_attempt_at: 'timestamptz not null',
			claimed_at: 'timestamptz',
			error: 'jsonb',
			epoch: 'text',
			acked_at: 'timestamptz',
			result: 'jsonb',
			at: 'timestamptz not null',
			instance: 'text not null',
			writer: 'text',
			bolt_record_label: 'text generated always as (bolt_record_label_sys_outbox_HASH(key)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_outbox_HASH(key), ''))) stored"
		},
		unique: [
			'(key)',
			"(sync, instance, record) where (attempts = '0'::int and status = 'queued'::text)"
		],
		indexes: [
			'(instance)',
			"(next_attempt_at) where (status = 'queued'::text)",
			"(sync) where (status = 'dead'::text)",
			'(sync, instance, record, record_revision)',
			"(sync, record, seq) where (status in ('queued'::text, 'sending'::text))",
			'(writer)',
			'using gin (bolt_search)'
		],
		fks: [
			'(instance) references sys_integration (id) on delete cascade on update restrict',
			'(writer) references sys_user (id) on delete set null on update restrict'
		],
		checks: [
			"((changed is null or store_json_valid(changed, '{default:[],kind:json,shape:{kind:text,many:true}}'::jsonb) is true))",
			"((error is null or store_json_valid(error, '{kind:json,optional:true}'::jsonb) is true))",
			"((image is null or store_json_valid(image, '{kind:json,optional:true}'::jsonb) is true))",
			"((result is null or store_json_valid(result, '{kind:json,optional:true}'::jsonb) is true))",
			"(delivery_op in ('create', 'update', 'delete'))",
			'(isfinite(acked_at))',
			'(isfinite(at))',
			'(isfinite(claimed_at))',
			'(isfinite(next_attempt_at))',
			"(op in ('create', 'update', 'delete'))",
			"(status in ('queued', 'sending', 'acked', 'failed', 'dead', 'skipped'))"
		]
	},
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
			starter: 'jsonb',
			trigger: 'jsonb',
			bolt_record_label:
				'text generated always as (bolt_record_label_sys_run_HASH(automation)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_run_HASH(automation), ''))) stored"
		},
		unique: ['(key)'],
		indexes: [
			'(automation, state)',
			"(due_at) where (state = 'queued'::text)",
			'using gin (bolt_search)'
		],
		checks: [
			"((error is null or store_json_valid(error, '{kind:json,optional:true}'::jsonb) is true))",
			"((input is null or store_json_valid(input, '{kind:json}'::jsonb) is true))",
			"((output is null or store_json_valid(output, '{kind:json,optional:true}'::jsonb) is true))",
			"((progress is null or store_json_valid(progress, '{kind:json,optional:true}'::jsonb) is true))",
			"((results is null or store_json_valid(results, '{default:[],kind:json}'::jsonb) is true))",
			"((starter is null or store_json_valid(starter, '{kind:json,optional:true}'::jsonb) is true))",
			"((trigger is null or store_json_valid(trigger, '{kind:json,optional:true}'::jsonb) is true))",
			'(isfinite(due_at))',
			'(isfinite(finished_at))',
			'(isfinite(started_at))'
		]
	},
	sys_session: {
		key: 'id text primary key',
		columns: {
			token_hash: 'text not null',
			via: 'text not null',
			created_at: 'timestamptz not null',
			expires_at: 'timestamptz not null',
			refreshed_at: 'timestamptz not null',
			agent: 'text',
			user: 'text not null',
			impersonated_by: 'text',
			bolt_record_label:
				'text generated always as (bolt_record_label_sys_session_HASH(via)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_session_HASH(via), ''))) stored"
		},
		unique: ['(token_hash)'],
		indexes: ['(impersonated_by)', '(user)', 'using gin (bolt_search)'],
		fks: [
			'(impersonated_by) references sys_user (id) on delete restrict on update restrict',
			'(user) references sys_user (id) on delete cascade on update restrict'
		],
		checks: [
			'(isfinite(created_at))',
			'(isfinite(expires_at))',
			'(isfinite(refreshed_at))',
			"(via in ('code', 'invitation', 'signup', 'host', 'anonymous'))"
		]
	},
	sys_sync: {
		key: 'id uuid primary key',
		columns: {
			sync: 'text not null',
			partition: 'text not null default ',
			cursor: 'jsonb',
			cycle: 'int not null default 0',
			phase: 'text not null default read',
			health: 'jsonb',
			digest: 'text not null',
			version: 'int not null default 0',
			started_at: 'timestamptz not null default now()',
			last_read_at: 'timestamptz',
			last_change_at: 'timestamptz',
			last_hint_at: 'timestamptz',
			instance: 'text not null',
			bolt_record_label: 'text generated always as (bolt_record_label_sys_sync_HASH(sync)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_sync_HASH(sync), ''))) stored"
		},
		unique: ['nulls not distinct (sync, instance, partition)'],
		indexes: ['(instance)', 'using gin (bolt_search)'],
		fks: ['(instance) references sys_integration (id) on delete cascade on update restrict'],
		checks: [
			"((cursor is null or store_json_valid(cursor, '{kind:json,optional:true}'::jsonb) is true))",
			"((health is null or store_json_valid(health, '{kind:json,optional:true}'::jsonb) is true))",
			'(isfinite(last_change_at))',
			'(isfinite(last_hint_at))',
			'(isfinite(last_read_at))',
			'(isfinite(started_at))',
			"(phase in ('read', 'reconcile'))"
		]
	},
	sys_sync_row: {
		key: 'id uuid primary key',
		columns: {
			sync: 'text not null',
			partition: 'text not null default ',
			remote_id: 'text',
			record: 'text not null',
			remote_version: 'text',
			cycle: 'int not null',
			acked_revision: 'int',
			instance: 'text not null',
			bolt_record_label:
				'text generated always as (bolt_record_label_sys_sync_row_HASH(remote_id)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_sync_row_HASH(remote_id), ''))) stored"
		},
		unique: [
			'nulls not distinct (sync, instance, record)',
			'(sync, instance, remote_id) where (remote_id is not null)'
		],
		indexes: ['(instance)', '(sync, instance, partition, cycle)', 'using gin (bolt_search)'],
		fks: ['(instance) references sys_integration (id) on delete cascade on update restrict']
	},
	sys_user: {
		key: 'id text primary key',
		columns: {
			email: 'text',
			name: 'text not null',
			kind: 'text not null default staff',
			active: 'boolean not null default true',
			admin: 'boolean not null default false',
			signup: 'boolean not null default false',
			team: 'text',
			party: 'jsonb',
			phone: 'text',
			telegram: 'text',
			slack: 'text',
			discord: 'text',
			revision: 'int not null default 1',
			created_at: 'timestamptz not null default now()',
			last_seen: 'timestamptz',
			party_id: "text generated always as (((party ->> 'id'))::text) stored",
			phone_key: "text generated always as ((regexp_replace(phone, '\\D', '', 'g'))::text) stored",
			bolt_record_label: 'text generated always as (bolt_record_label_sys_user_HASH(name)) stored',
			bolt_search:
				"tsvector generated always as (bolt_search_document(coalesce(bolt_record_label_sys_user_HASH(name), '') || ' ' || coalesce(name::text, '') || ' ' || coalesce(email::text, ''))) stored"
		},
		unique: ['(lower(email))', '(phone_key)'],
		indexes: ['using gin (bolt_search)'],
		checks: [
			"((coalesce(admin = false, false) or coalesce(kind = 'staff'::text, false)))",
			"((party is null or store_json_valid(party, '{kind:json,optional:true}'::jsonb) is true))",
			"(email ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')",
			'(isfinite(created_at))',
			'(isfinite(last_seen))',
			"(kind in ('staff', 'external', 'anonymous'))"
		]
	}
};

describe('the built-in layer is compiled as a workspace is', () => {
	it.effect(
		'approval requests and users declare text search and install their native GIN indexes',
		() =>
			Effect.gen(function* () {
				expect(SYSTEM.models.approval_request?.search?.text).toEqual(['collection_name']);
				expect(SYSTEM.models.sys_user?.search?.text).toEqual(['name', 'email']);
				const objects = yield* schema_objects(schema_slice(EMPTY));
				for (const table of ['approval_request', 'sys_user'])
					expect(
						objects.some(
							(object) =>
								object.table === table && object.create.some((sql) => /USING gin/i.test(sql))
						)
					).toBe(true);
			})
	);
	it.effect(
		'src/system/index.ts imports exactly the discovered declarations, and loading them gives SYSTEM',
		() =>
			Effect.gen(function* () {
				const { files, errors } = yield* discover(ROOT, 'system');
				const fs = yield* FileSystem.FileSystem;
				expect(errors).toEqual([]);
				const index = yield* fs.readFileString(join(ROOT, 'src/system/index.ts'));
				const imports = [...index.matchAll(/^import [mi]_\w+ from '\.\/([^']+)';$/gm)].map(
					(match) => capture(match, 1)
				);
				expect(imports.sort()).toEqual(
					files.map(({ path }) => path.slice('src/system/'.length)).sort()
				);
				expect(
					files
						.filter(({ role }) => role === 'model')
						.map(({ name }) => name)
						.sort()
				).toEqual(Object.keys(SYSTEM.models).sort());
				expect(
					files
						.filter(({ role }) => role === 'integration_definition')
						.map(({ name }) => name)
						.sort()
				).toEqual(Object.keys(SYSTEM.integrations).sort());
				const loaded = yield* load(ROOT, files);
				expect(loaded.errors).toEqual([]);
				expect(manifestErrors(loaded.manifest, 'system')).toEqual([]);
				// lowered as src/system/index.ts lowers them: built-in tables carry their physical `table`
				const parts = Object.entries(loaded.manifest.model).map(
					([name, d]) => [name, split_system_model(name, spec(d))] as const
				);
				expect(
					JSON.parse(
						JSON.stringify({
							models: Object.fromEntries(parts.map(([name, part]) => [name, part.model])),
							relationships: Object.assign({}, ...parts.map(([, part]) => part.relationships)),
							exposures: Object.fromEntries(
								parts.flatMap(([name, part]) =>
									part.exposure === undefined ? [] : [[name, part.exposure]]
								)
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
					'chat:chat',
					'discord:discord',
					'email:email',
					'slack:slack',
					'telegram:telegram',
					'wechat:wechat',
					'whatsapp:whatsapp'
				]);
			}).pipe(Effect.provide(Platform))
	);

	it('every system model has its model, and private auth, config and sync models are no model', () => {
		for (const c of Object.keys(SYSTEM.exposures)) expect(SYSTEM.models[c]).toBeDefined();
		expect(
			Object.keys(SYSTEM.models)
				.filter((m) => !Object.hasOwn(SYSTEM.exposures, m))
				.sort()
		).toEqual([
			'sys_challenge',
			'sys_config',
			'sys_inbox',
			'sys_outbox',
			'sys_session',
			'sys_sync',
			'sys_sync_row'
		]);
	});
});

describe('the schema plan renders the built-in native contract', () => {
	const now = rendered();
	it('renders exactly the system tables', () =>
		expect(Object.keys(now).sort()).toEqual(Object.keys(EXPECTED).sort()));
	for (const [table, shape] of Object.entries(EXPECTED))
		it(table, () => {
			const sorted = Object.fromEntries(
				shape_lists.flatMap((x) => {
					const values = shape[x];
					return values === undefined ? [] : [[x, [...values].sort()]];
				})
			);
			expect(now[table]).toEqual({ ...shape, ...sorted });
		});

	it.effect('guards every system table with its native row rules', () =>
		Effect.gen(function* () {
			const triggers = (yield* schema_objects(schema_slice(EMPTY)))
				.filter((o) => o.id.startsWith('trigger:') && Object.hasOwn(SYSTEM.models, o.table))
				.map((o) => o.id)
				.sort();
			expect(triggers).toEqual(
				Object.keys(SYSTEM.models)
					.map((table) => `trigger:${table}.store_row_rules`)
					.sort()
			);
		})
	);

	it.effect(
		"the empty-database plan creates the layer's tables and the engine's private objects; the same slice plans no step",
		() =>
			Effect.gen(function* () {
				const p = yield* plan(null, EMPTY);
				for (const t of Object.keys(SYSTEM.models))
					expect(p.steps.some((s) => s.id === `create:table:${t}`)).toBe(true);
				expect(p.steps.filter((s) => s.id.startsWith('create:engine:'))).toHaveLength(
					engineObjects().length
				);
				expect((yield* plan(yield* schema_snapshot(p.slice), EMPTY)).steps).toEqual([]);
			})
	);

	it.effect(
		'an FK to a system table takes its key type: text to sys_user, uuid to approval_request; a workspace model uuid',
		() =>
			Effect.gen(function* () {
				const m: EngineManifest = {
					...EMPTY,
					models: {
						notes: {
							description: 'n',
							record_label: 'record.body',
							fields: { body: { kind: 'text' } }
						}
					},
					relationships: {
						'notes.owner': { to: 'sys_user' },
						'notes.request': { to: 'approval_request', optional: true },
						'notes.parent': { to: 'notes', optional: true }
					}
				};
				const objects = yield* schema_objects(schema_slice(m));
				const col = (c: string) => objects.find((o) => o.id === `column:notes.${c}`)?.create[0];
				expect([col('owner'), col('request'), col('parent')]).toEqual([
					'alter table "notes" add column "owner" text',
					'alter table "notes" add column "request" uuid',
					'alter table "notes" add column "parent" uuid'
				]);
			})
	);

	it.effect(
		'a system table has no engine columns or approval index, and its uniques are plain (an on-conflict arbiter)',
		() =>
			Effect.gen(function* () {
				const run = (yield* schema_objects(schema_slice(EMPTY))).filter(
					(o) => o.table === 'sys_run'
				);
				expect(run.some((o) => o.id.includes('__approval__'))).toBe(false);
				expect(run.flatMap((o) => o.create).filter((s) => s.includes('deferrable'))).toEqual([]);
			})
	);
});

describe('the catalogue reads the system models from their declarations', () => {
	const cat = catalog(EMPTY);
	it('exposes every system model with its declared fields and relationships', () => {
		expect([...cat.exposures.keys()].sort()).toEqual(Object.keys(SYSTEM.exposures).sort());
		const user = cat.models.get('sys_user');
		if (user === undefined) throw new Error('Missing sys_user in the system catalogue');
		expect(user.fields.get('email')).toMatchObject({ email: true, pg: 'text' });
		expect(user.fields.get('id')).toMatchObject({ pg: 'text' });
		expect(user.fields.has('approval_id')).toBe(false);
		expect(user.one.has('team')).toBe(false);
		expect(user.fields.get('team')).toMatchObject({ kind: 'text', team: true, pg: 'text' });
		expect(cat.models.get('approval_request')?.fields.get('id')).toMatchObject({ pg: 'uuid' });
		expect(cat.exposures.get('sys_api_key')?.fields).toEqual(
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
		"refuses a model or model named as the layer's (sys_*, bolt_*, approval_request, requestor): discover/reserved-name",
		() =>
			Effect.gen(function* () {
				expect(
					yield* workspace({
						'src/data/model/sys_user/+model.ts': '',
						'src/data/model/requestor/+model.ts': '',
						'src/data/model/bolt_x/+model.ts': '',
						'src/data/model/approval_request/+model.ts': '',
						'src/data/model/orders/+model.ts': ''
					})
				).toEqual([
					'discover/reserved-name src/data/model/approval_request/+model.ts',
					'discover/reserved-name src/data/model/bolt_x/+model.ts',
					'discover/reserved-name src/data/model/requestor/+model.ts',
					'discover/reserved-name src/data/model/sys_user/+model.ts'
				]);
			})
	);
	it('refuses system table metadata on a workspace model', () => {
		const manifest: Manifest = Schema.decodeUnknownSync(
			Schema.Record(
				Schema.Literals(ROLES.map(({ role }) => role)),
				Schema.Record(Schema.String, Schema.Unknown)
			)
		)({
			...Object.fromEntries(ROLES.map(({ role }) => [role, {}])),
			model: {
				notes: {
					name: 'notes',
					spec: {
						description: 'Notes',
						record_label: 'record.body',
						fields: { body: { kind: 'text' } },
						table: { primary: 'text' }
					}
				}
			}
		});
		expect(manifestErrors(manifest).map((error) => error.code)).toEqual(['load/system-only']);
		expect(manifestErrors(manifest, 'system')).toEqual([]);
	});
});

describe('a seed pack seeds runtime accounts of defined integrations', () => {
	const m: EngineManifest = EMPTY;
	const decode = (row: { [field: string]: string | boolean }) => {
		return Result.match(
			Result.try({
				try: () => decode_identity(m, { sys_integration: [row] }),
				catch: (error) => (error instanceof Error ? error.message : String(error))
			}),
			{
				onSuccess: () => null,
				onFailure: (message) => message
			}
		);
	};
	it('admits an arbitrary runtime account id; refuses named metadata, envoy deployment, an unknown definition and a row without an id', () => {
		const id = '0199a000-0000-7000-8000-000000000001';
		expect(
			decode({ id, integration: 'whatsapp', name: 'Sales line', owner: 'u1', active: false })
		).toBeNull();
		expect(decode({ id: 'mail', integration: 'email', name: 'Mail' })).toBeNull();
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
			decode_identity(erp, {
				sys_integration: [
					{ id, integration: 'erp', name: 'Ledger', configuration: { region: 'sg' } }
				]
			})['sys_integration']
		).toEqual([
			{ id, integration: 'erp', name: 'Ledger', configuration: { lag: 15, region: 'sg' } }
		]);
		// a null is absent, so the default fills it: a body reads every defaulted field present, an optional one may be null
		const definition = erp.integrations['erp'];
		if (definition === undefined) throw new Error('Missing ERP fixture definition');
		const note: EngineManifest = {
			...erp,
			integrations: {
				erp: {
					...definition,
					configuration: {
						lag: { kind: 'int', default: 15 },
						note: { kind: 'text', optional: true, default: 'x' }
					}
				}
			}
		};
		expect(
			decode_identity(note, {
				sys_integration: [
					{ id, integration: 'erp', name: 'Ledger', configuration: { lag: null, note: null } }
				]
			})['sys_integration']
		).toEqual([{ id, integration: 'erp', name: 'Ledger', configuration: { lag: 15, note: null } }]);
		expect(() =>
			decode_identity(erp, {
				sys_integration: [
					{ id, integration: 'erp', name: 'Ledger', configuration: { lag: 'soon' } }
				]
			})
		).toThrow(
			/sys_integration\[0\]: The configuration is invalid: region is required; lag Expected number \| null\./
		);
	});
});
