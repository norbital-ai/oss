// The integrations workspace: serial-pcn's supplier mail as the one_way reference (`pcn_notices` mirrors the
// `supplier_inbox` channel; no grant names it) and a two_way ERP (`accounts` ↔ `/customers` over HTTP, `credit_limit`
// owned by the ERP, `note` settled local-wins), plus crm's ERP item import and a CSV export as pipelines.
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/contracts.ts';
import type { HttpPort, HttpRequest } from '../src/engine/integrations/runner.ts';

export const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		suppliers: { description: 'A supplier', label: 'name', unique: [{ fields: ['name'] }], fields: { name: { kind: 'text' }, domain: { kind: 'text' } } },
		pcn_notices: {
			description: 'A supplier notice', label: 'subject', unique: [{ fields: ['message_id'] }],
			fields: { message_id: { kind: 'text' }, received_at: { kind: 'instant' }, subject: { kind: 'text' }, raw_body: { kind: 'text' },
				from_address: { kind: 'text' }, attachment_manifest: { kind: 'json' } },
		},
		accounts: {
			description: 'A customer account', label: 'name', unique: [{ fields: ['erp_id'] }],
			fields: { erp_id: { kind: 'text', optional: true }, name: { kind: 'text' }, credit_limit: { kind: 'int', optional: true }, note: { kind: 'text', optional: true } },
		},
		products: { description: 'A product', label: 'name', key: ['external_code'],
			fields: { external_code: { kind: 'text' }, name: { kind: 'text' }, price: { kind: 'decimal', scale: 2, optional: true } } },
	},
	relationships: { 'pcn_notices.supplier': { to: 'suppliers', inverse: 'notices', optional: true } },
	collections: {
		suppliers: { read: { fields: 'all' }, create: { input: { columns: ['name', 'domain'] } } },
		// one_way: read only by type (§3.3.5)
		pcn_notices: { read: { fields: 'all' } },
		accounts: { read: { fields: 'all' }, create: { input: { columns: ['name', 'note'] } }, update: { input: { columns: ['name', 'note', 'credit_limit'] } }, delete: {} },
		products: { read: { fields: 'all' }, create: { input: { columns: ['external_code', 'name', 'price'] } }, update: { input: { columns: ['name', 'price'] } } },
	},
	integrations: {
		pcn_notices: {
			direction: 'one_way', source: { channel: 'supplier_inbox', inbound: true }, identity: 'message_id', resolve: true,
			fields: { received_at: 'sentAt', subject: 'subject', raw_body: 'text', from_address: { in: true }, supplier: { in: true }, attachment_manifest: { in: true } },
			policies: ['integration'],
		},
		accounts: {
			direction: 'two_way', identity: 'erp_id',
			source: { connection: 'erp', list: { path: '/customers', records: 'data', cursor: 'next' }, create: { path: '/customers' },
				update: { path: '/customers/{id}' }, delete: { path: '/customers/{id}' }, pull: { cron: '*/5 * * * *' } },
			fields: { name: 'name', credit_limit: 'credit_limit', note: 'note' },
			owns: { remote: ['credit_limit'] },
			conflicts: { default: 'remote_wins', fields: { note: 'local_wins' } },
			policies: ['integration'],
		},
	},
	pipelines: {
		products: {
			import: { description: 'Mirrors the ERP item feed, skipping codes already on file.', known: true, onConflict: 'keep',
				input: { items: { kind: 'list', of: { kind: 'object', fields: { external_code: { kind: 'text' }, name: { kind: 'text' },
					unit_price: { kind: 'decimal', optional: true } } } } } },
			export: { description: 'The catalogue as CSV.', select: ['external_code', 'name', 'price'], format: 'csv' },
		},
	},
	policies: {
		viewer: { description: 'Reads the catalogue', grants: { products: { read: true } } },
		integration: { description: 'The supplier mail and ERP integrations', grants: { suppliers: { read: true } } },
		sales: { description: 'Sales', grants: { accounts: { read: true, create: true, update: true, delete: true }, pcn_notices: { read: true },
			products: { read: true, create: true, update: true } } },
	},
	teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

/** `guest.mjs` for the bodies: serial-pcn's `+supplier_mail.ts` (`resolve` returns a plain object: bodies cross as JSON) and crm's item import. */
export const guestSource = `
const domainOf = (address) => address?.match(/@([^\\s>]+)/)?.[1]?.toLowerCase();
export default {
	integration: { pcn_notices: { spec: {
		resolve: async (ctx) => Object.fromEntries((await ctx.read('suppliers', { all: true })).rows.map((s) => [s.domain, s.id])),
		fields: {
			from_address: { in: (mail) => mail.replyTo?.address ?? mail.from.address },
			supplier: { in: (mail, { resolve }) => resolve[domainOf(mail.from.address) ?? ''] ?? resolve[domainOf(mail.replyTo?.address) ?? ''] ?? null },
			attachment_manifest: { in: (mail) => mail.attachments.map((f) => ({ name: f.fileName, kind: f.mimeType, size: f.byteLength })) },
		},
	} } },
	pipeline: { products: { spec: { import: {
		records: (input) => input.items.map((i) => ({ ...i, external_code: i.external_code.trim(), name: i.name.trim() })),
		// ponytail: { in: codes } binds a list the PGlite adapter cannot pass (query/sql.ts 'in'); filtered here until it can
		known: async (ctx, codes) => (await ctx.read('products', { all: true })).rows.filter((r) => codes.includes(r.external_code)),
		map: (item, { known }) => known[item.external_code] ? null : { external_code: item.external_code, name: item.name, price: item.unit_price ?? null },
	} } } },
};`;

export const mail = (over: { [k: string]: Json } = {}): Json => ({
	id: '<pcn-1@onsemi.com>', thread: null, sentAt: '2026-09-20T08:00:00.000Z', from: { address: 'noreply@notify.example', name: null },
	replyTo: { address: 'pcn@onsemi.com', name: 'onsemi' }, to: [], cc: [], subject: 'PCN 1234: wafer fab move', text: 'Affected: NCP1117',
	html: null, headers: {}, attachments: [{ file: { $file: 'f1' }, fileName: 'pcn.pdf', mimeType: 'application/pdf', byteLength: 2048 }], ...over,
});

export type Customer = { id: string; name: string; credit_limit: number | null; note: string | null };
/**
 * The ERP: `/customers` paged two per page, creates idempotent by key. `lose` decides a request's fate: dropped before
 * the ERP sees it, or applied with its answer lost.
 */
export function fakeErp() {
	const records = new Map<string, Customer>(), keys = new Map<string, string>();
	let seq = 0;
	const erp = {
		records, calls: [] as HttpRequest[], down: false,
		lose: (_r: HttpRequest): 'request' | 'answer' | null => null,
		add(c: Omit<Customer, 'id'>): Customer { const r = { id: `E${++seq}`, ...c }; records.set(r.id, r); return r; },
		port: {
			async request(connection, r) {
				erp.calls.push(r);
				if (connection !== 'erp') throw new Error('unknown connection');
				if (erp.down) return { status: 503, body: { error: 'maintenance' } };
				const fate = erp.lose(r);
				if (fate === 'request') throw new Error('connection reset');
				const answer = apply(r);
				if (fate === 'answer') throw new Error('connection reset');
				return answer;
			},
		} satisfies HttpPort,
	};
	const apply = (r: HttpRequest): { status: number; body: Json } => {
		const id = decodeURIComponent(r.path.split('/')[2] ?? '');
		const body = (r.body ?? {}) as Partial<Customer>;
		if (r.method === 'GET') {
			const all = [...records.values()], at = Number(r.query?.['next'] ?? 0);
			return { status: 200, body: { data: all.slice(at, at + 2), next: at + 2 < all.length ? String(at + 2) : null } };
		}
		if (r.method === 'POST') {
			const known = r.key === undefined ? undefined : keys.get(r.key);
			if (known !== undefined && records.has(known)) return { status: 200, body: records.get(known)! };
			const made = erp.add({ name: body.name ?? '', credit_limit: body.credit_limit ?? null, note: body.note ?? null });
			if (r.key !== undefined) keys.set(r.key, made.id);
			return { status: 201, body: made };
		}
		const rec = records.get(id);
		if (rec === undefined) return { status: 404, body: { error: 'not found' } };
		if (r.method === 'DELETE') { records.delete(id); return { status: 204, body: null }; }
		records.set(id, { ...rec, ...body, id });
		return { status: 200, body: records.get(id)! };
	};
	return erp;
}
