import { describe, expect, it, vi } from '@effect/vitest';
import { Result } from 'effect';
import type { ExposureSpec } from '../src/decl/model.ts';
import { decode_projected_manifest } from '../src/engine/manifest.ts';
import { inboxPiece, reportRowsPiece } from '../src/engine/sync/hint.ts';
import { Chain } from '../src/engine/write/sql.ts';

const NOW = '2026-10-24T08:00:00.000Z';
const manifest = (syncs: ExposureSpec['syncs']) =>
	Result.getOrThrow(
		decode_projected_manifest({
			workspace: { tz: 'UTC', locale: 'en' },
			models: {
				contacts: {
					description: 'A contact',
					record_label: 'record.name',
					fields: { name: { kind: 'text' } }
				}
			},
			relationships: {},
			exposures: { contacts: { outputs: { default: { contacts: { fields: 'all' } } }, syncs } },
			integrations: {
				crm: { description: 'CRM', driver: 'http', http: { base_url: 'https://crm.test' } },
				other: { description: 'Other', driver: 'http', http: { base_url: 'https://other.test' } }
			},

			policies: {},
			teams: {},
			automations: {},
			mcp: {},
			apps: {},
			custom_fields: {},
			agent: { skills: {} }
		})
	);
const finish = (c: Chain) => {
	c.cte('later', `SELECT ${c.p('after')}::text AS value`);
	const sql = c.sql('(SELECT value FROM later) AS value');
	const referenced = [...new Set([...sql.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))];
	expect(referenced.sort((a, b) => a - b)).toEqual(sql.params.map((_, i) => i + 1));
	return sql;
};

describe('sync hint SQL source allocation', () => {
	it('leaves no unused inbox parameters when only another definition has a reader', () => {
		const c = new Chain();
		const source = vi.fn(() => `SELECT ${c.p('unused')}::text AS delivery, '{}'::jsonb AS body`);
		inboxPiece(
			manifest({ push: { with: 'crm', write: true }, read_other: { with: 'other', read: true } }),
			c,
			'inbox',
			'crm',
			'crm',
			source,
			NOW
		);
		expect(source).not.toHaveBeenCalled();
		expect(finish(c).params).toEqual(['after']);
	});
	it('leaves no unused report parameters without a sync that both reads and writes', () => {
		const c = new Chain();
		const source = vi.fn(() => `SELECT ${c.p('unused')}::text AS instance`);
		reportRowsPiece(
			manifest({ pull: { with: 'crm', read: true }, push: { with: 'other', write: true } }),
			c,
			source,
			NOW
		);
		expect(source).not.toHaveBeenCalled();
		expect(finish(c).params).toEqual(['after']);
	});
	it('builds one inbox source for exactly the matching read syncs', () => {
		const c = new Chain();
		const source = vi.fn(
			() =>
				`SELECT ${c.p('delivery')}::text AS delivery, ${c.p({ kind: 'message' })}::jsonb AS body`
		);
		inboxPiece(
			manifest({
				pull: { with: 'crm', read: true },
				both: { with: 'crm', read: true, write: true },
				push: { with: 'crm', write: true },
				read_other: { with: 'other', read: true }
			}),
			c,
			'inbox',
			'crm',
			'crm',
			source,
			NOW
		);
		expect(source).toHaveBeenCalledTimes(1);
		expect(finish(c).params).toContain(
			JSON.stringify(['contacts.sync.pull', 'contacts.sync.both'])
		);
	});
	it('builds one report source for exactly the syncs that both read and write', () => {
		const c = new Chain();
		const source = vi.fn(
			() => `SELECT ${c.p('crm')}::text AS instance, ${c.p('message')}::text AS message,
			${c.p('delivery')}::text AS delivery, ${c.p({ kind: 'sent' })}::jsonb AS body`
		);
		reportRowsPiece(
			manifest({
				both: { with: 'crm', read: true, write: true },
				pull: { with: 'crm', read: true },
				push: { with: 'crm', write: true },
				both_other: { with: 'other', read: true, write: true }
			}),
			c,
			source,
			NOW
		);
		expect(source).toHaveBeenCalledTimes(1);
		expect(finish(c).params).toContain(
			JSON.stringify(['contacts.sync.both', 'contacts.sync.both_other'])
		);
	});
});
