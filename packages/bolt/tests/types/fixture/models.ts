import { install } from '../../../src/decl/runtime/guest.ts';
install();
// A hand-written workspace for the type corpus: the `src/data/model/<name>/+model.ts` literals a template writes, every
// body inline. `../registry.ts` is what `bolt sync` prints for them: each body is typed from it by the model's name.
import { custom_field, model } from '../../../src/index.ts';
import type { Finding, Notice, SyncRow } from '../../../src/index.ts';

export const customers = model('customers', {
	description: 'Buyers',
	record_label: 'record.name',
	fields: {
		name: { kind: 'text' },
		email: { kind: 'text', format: 'email', optional: true },
		tier: { kind: 'enum', values: ['basic', 'gold'], default: 'basic' },
		tags: { kind: 'text', many: true, optional: true },
		order_count: { kind: 'count', of: 'orders' },
		hotline: {
			kind: 'ref',
			to: 'sys_integration',
			optional: true,
			where: { integration: { eq: 'whatsapp' } }
		},
		name_upper: { kind: 'text', computed: { upper: { field: 'name' } } },
		email_lower: { kind: 'text', computed: { lower: { field: 'email' } } },
		email_label: { kind: 'text', computed: { concat: [{ field: 'email' }, ' contact'] } },
		email_default: { kind: 'text', computed: { coalesce: [{ field: 'email' }, 'unknown'] } },
		email_chain: { kind: 'text', computed: { upper: { field: 'email_lower' } } }
	},

	outputs: { default: { fields: 'all' }, directory: { fields: ['name', 'tier'] } },
	create: {
		columns: { customers: ['name', 'email', 'tier'] },
		filled: { customers: ['name'] },
		transform: function* (rows) {
			return rows.map((r) => (r.name === undefined ? { ...r, name: r.email ?? 'unknown' } : r));
		}
	},
	update: { columns: { customers: ['name', 'email', 'tier', 'tags'] } },
	syncs: {
		// two ways with the ERP: `read` pulls changed customers, `write` sends each committed change
		crm: {
			with: 'erp',
			every: '1h',
			read: function* ({ cursor }, ctx) {
				const page = yield* ctx.request({
					method: 'GET',
					path: 'customers',
					query: { since: String(cursor ?? '') },
					output: {
						kind: 'object',
						fields: { id: { kind: 'text' }, name: { kind: 'text' }, updated: { kind: 'text' } },
						many: true
					}
				});
				return {
					rows: page.map((c) => ({ $id: c.id, $version: c.updated, name: c.name })),
					cursor: page.length,
					more: false
				};
			},
			write: function* ({ op, row, $id, $version }, ctx) {
				const sent = yield* ctx.request({
					method: op === 'create' ? 'POST' : op === 'update' ? 'PATCH' : 'DELETE',
					path: $id === null ? 'customers' : `customers/${$id}`,
					headers: $version === null ? {} : { 'If-Match': $version },
					body: { name: row.name },
					output: { kind: 'object', fields: { id: { kind: 'text' }, updated: { kind: 'text' } } }
				});
				return { $id: sent.id, $version: sent.updated };
			}
		}
	},
	indexes: { find: { text: ['name'] } }
});

export const orders = model('orders', {
	description: 'Sales orders',
	record_label:
		"[record.number != null ? string(record.number) : '', record.customer != null ? string(record.customer) : ''].filter(part, part != '').join(' · ')",
	fields: {
		number: { kind: 'seq', pattern: 'SO-{0000}' },
		customer: { kind: 'ref', to: 'customers', inverse: 'orders' },
		owner: { kind: 'ref', to: 'sys_user', optional: true, default: { var: 'requestor.id' } },
		ledger: {
			kind: 'ref',
			to: 'sys_integration',
			optional: true,
			where: { integration: { eq: 'kingdee' } }
		},
		status: {
			kind: 'state',
			initial: 'draft',
			states: {
				draft: { to: ['submitted'] },
				submitted: { to: ['ordered', 'draft'], edit: ['status', 'note', 'lines'] },
				ordered: { edit: 'none' }
			}
		},
		note: { kind: 'text', optional: true },
		due: { kind: 'date', optional: true },
		placed_at: { kind: 'instant', optional: true },
		total: { kind: 'sum', of: 'lines.amount', where: { qty: { gt: 0 } } },
		line_count: { kind: 'count', of: 'lines' },
		colour: { kind: 'vector', dim: 3, metric: 'l2', optional: true },
		due_soon: { kind: 'date', computed: { plusDays: [{ field: 'due' }, -7] } }
	},

	constraints: { has_customer: { check: { customer: { is_null: false } } } },

	outputs: {
		default: { fields: 'all', customer: { fields: ['name', 'tier'] }, lines: { fields: 'all' } },
		logistics: { fields: ['number', 'status', 'customer'], lines: { fields: ['item', 'qty'] } }
	},
	create: {
		columns: { orders: ['customer', 'note', 'due'], 'orders.lines': ['item', 'qty', 'price'] },
		transform: function* (rows, ctx) {
			const known = yield* ctx.query({
				customers: {
					where: { id: { in: rows.map((r) => r.customer) } },
					fields: ['tier']
				}
			});
			const at = rows.findIndex((r) => !known.customers.rows.some((c) => c.id === r.customer));
			if (at >= 0) return yield* ctx.refuse('Unknown customer.', { field: 'customer', row: at });
			return rows.map((r) => ({ ...r, placed_at: ctx.now }));
		}
	},
	update: {
		columns: {
			orders: ['status', 'note', 'due', 'placed_at'],
			'orders.lines': ['item', 'qty', 'price']
		},
		transform: function* (changes, ctx) {
			return changes.map(({ before, set }) =>
				set.status === 'submitted' && before.status !== 'submitted'
					? { ...set, placed_at: ctx.now }
					: set
			);
		}
	},
	delete: {
		check: function* (rows, ctx) {
			const at = rows.findIndex((r) => r.status === 'ordered');
			if (at >= 0) return yield* ctx.refuse('An ordered order stays.', { row: at });
		}
	},
	notify: function* (event, ctx) {
		if (event.kind !== 'write' || event.action !== 'create') return [];
		const buyers = yield* ctx.query({
			customers: {
				where: { id: { in: event.records.map((o) => o.customer) } },
				fields: ['name']
			}
		});
		return event.records.map((o): Notice => ({
			title: `New order ${o.number}`,
			description: buyers.customers.rows.find((c) => c.id === o.customer)?.name ?? '',
			to: [{ team: 'finance' }, 'requester'],
			via: ['whatsapp'],
			attachments: [{ document: { html: `<h1>${o.number}</h1>` }, to: 'pdf', name: 'order.pdf' }],
			link: { model: 'orders', id: o.id }
		}));
	},
	effect: {
		created: function* (rows, ctx) {
			const first: string | undefined = rows[0]?.number;
			const actor: 'member' | 'envoy' | 'visitor' | 'api_key' | 'system' = ctx.actor.kind;
			if (first !== undefined && actor === 'member') yield* ctx.schedule('nightly', {});
		},
		updated: function* (changes, ctx) {
			const moved = changes.filter(({ before, after }) => before.status !== after.status);
			if (moved.length > 0)
				yield* ctx.act(
					'orders.update',
					moved.map(({ after }) => ({ target: after.id, set: { note: 'moved' } }))
				);
		},
		deleted: function* (rows, ctx) {
			yield* ctx.notify(
				rows.map((o) => ({ title: `Order ${o.number} removed`, to: [{ team: 'finance' }] }))
			);
		}
	},
	syncs: {
		// one way out: an ordered order is submitted to the ledger
		ledger: {
			with: 'kingdee',
			write: function* ({ op, row, $id }, ctx) {
				if (op === 'delete') return null;
				yield* ctx.request({
					op: 'call',
					procedure: { schema: 'dbo', name: 'submit' },
					arguments: { reference: row.number }
				});
				return { $id: $id ?? row.number };
			}
		},
		// a sheet: import by customer name, export the open orders
		sheet: {
			with: 'file',
			parser: [
				'xlsx',
				'csv',
				{
					type: 'application/vnd.ms-excel',
					extensions: ['.xls'],
					parse: function* (file, ctx) {
						const text = new TextDecoder('utf-8', { fatal: true }).decode(
							yield* ctx.files.get(file)
						);
						return text.split('\n').map((line, i) => ({ customer: line, note: null, $at: i + 1 }));
					}
				}
			],
			schema: {
				customer: { kind: 'text', label: 'Customer' },
				note: { kind: 'text', optional: true }
			},
			context: { since: { kind: 'date' } },
			read: function* ({ records, context }, ctx) {
				const known = yield* ctx.query({
					customers: {
						where: { name: { in: records.map((r) => r.customer) } },
						fields: ['name']
					}
				});
				const id_of = (name: string) => known.customers.rows.find((c) => c.name === name)?.id;
				return {
					rows: records.flatMap((r) => {
						const customer = id_of(r.customer);
						return customer === undefined
							? []
							: [{ customer, note: r.note ?? null, due: context.since }];
					}),
					scope: { by: ['customer'], range: 'due' },
					findings: records.flatMap((r): Finding[] =>
						id_of(r.customer) === undefined
							? [{ at: r.$at, field: 'customer', message: 'Unknown customer', severity: 'refuse' }]
							: []
					)
				};
			},
			write: function* ({ context }, ctx) {
				const open = yield* ctx.query({
					orders: {
						where: { due: { gte: context.since } },
						fields: ['customer', 'note']
					}
				});
				return open.orders.rows.map((o) => ({ customer: String(o.customer), note: o.note }));
			}
		}
	},
	indexes: {
		by_customer: { on: ['customer'] },
		by_due: { on: ['due'] },
		find: { text: ['note'] },
		by_colour: {
			description: 'Orders of a similar colour',
			dim: 3,
			metric: 'l2',
			vector: 'colour',
			input: { lab: { kind: 'vector', dim: 3, metric: 'l2' } },
			candidates: 4,
			probe: (q) => ({ vector: q.lab, where: { status: { eq: 'ordered' } } }),
			rerank: (q, row) => (Array.isArray(row.colour) ? row.colour.length - q.lab.length : undefined)
		}
	}
});

export const order_lines = model('order_lines', {
	description: 'Lines of an order',
	record_label: 'record.item',
	fields: {
		order: { kind: 'ref', to: 'orders', inverse: 'lines', owned: true },
		item: { kind: 'text' },
		qty: { kind: 'decimal', scale: 3 },
		price: { kind: 'money' },
		amount: {
			kind: 'money',
			computed: { round: [{ times: [{ field: 'price' }, { field: 'qty' }] }, 2] }
		}
	},

	outputs: { default: { fields: 'all' } }
});

export const notices = model('notices', {
	description: 'Supplier notices mirrored from the inbox',
	record_label: 'record.subject',
	key: ['inbox', 'message_id'],
	fields: {
		inbox: { kind: 'ref', to: 'sys_integration', where: { integration: { eq: 'support_mail' } } },
		message_id: { kind: 'text' },
		subject: { kind: 'text' },
		received_at: { kind: 'instant' }
	},

	outputs: { default: { fields: 'all' } },
	syncs: {
		// one way in: the mailbox's messages are its deliveries
		mail: {
			with: 'support_mail',
			read: function* ({ deliveries }) {
				return {
					rows: deliveries.flatMap((d): readonly SyncRow<'notices'>[] =>
						d.kind !== 'message'
							? []
							: d.message.deleted
								? [{ $id: d.message.id, $deleted: true }]
								: [
										{
											$id: d.message.id,
											$version: d.message.version,
											message_id: d.message.id,
											subject: d.message.subject || '(no subject)',
											received_at: d.message.sentAt
										}
									]
					)
				};
			}
		}
	},
	indexes: {
		find: { text: ['subject'] },
		semantic: { semantic: { fields: ['subject'], model: 'text_small', dim: 1536 } }
	}
});

export const notice_notes = model('notice_notes', {
	description: 'What we add about a notice',
	record_label: 'record.notice',
	fields: {
		notice: { kind: 'ref', to: 'notices', inverse: 'notes', owned: true },
		integration: { kind: 'ref', to: 'sys_integration', optional: true },
		note: { kind: 'text' }
	},
	constraints: { one_notice: { unique: ['notice'] } },
	outputs: { default: { fields: 'all' } },
	create: { columns: { notice_notes: ['notice', 'note'] } },
	update: { columns: { notice_notes: ['note'] } }
});

export const sites = model('sites', {
	description: 'Customer sites',
	record_label: 'record.name',
	fields: {
		name: { kind: 'text', max: 120 },
		customer: {
			kind: 'ref',
			to: 'customers',
			optional: true,
			on_delete: 'set_null',
			inverse: 'sites',
			where: { tier: { eq: 'gold' } }
		},
		zone: { kind: 'text', format: 'zone' },
		notes: { kind: 'text', format: 'markdown', optional: true },
		location: { kind: 'point', optional: true },
		open: { kind: 'period', of: 'date' },
		opens_at: { kind: 'time', optional: true },
		slot: { kind: 'int', default: 1800 },
		photos: { kind: 'file', accept: ['image/*'], max: '5MiB', many: true, optional: true },
		checklist: {
			kind: 'json',
			shape: {
				kind: 'object',
				fields: { item: { kind: 'text' }, done: { kind: 'bool' } },
				many: true
			}
		},
		rating: { kind: 'custom', of: 'rating', optional: true },
		budget: { kind: 'money', currency: 'EUR', optional: true }
	},
	constraints: {
		no_overlapping_sites: { no_overlap: 'open', per: ['name'] },
		zoned: { locked: { zone: { is_null: false } } }
	},
	outputs: {
		default: { fields: ['name', 'location', 'customer', 'open', 'rating', 'checklist'] },
		summary: { fields: ['name', 'open'] }
	},
	update: { columns: { sites: ['name', 'location'] } }
});

export const products = model('products', {
	description: 'Products from the ledger',
	record_label: 'record.name',
	key: ['source', 'external_code'],
	fields: {
		source: { kind: 'ref', to: 'sys_integration', where: { integration: { eq: 'kingdee' } } },
		external_code: { kind: 'text' },
		name: { kind: 'text' },
		active: { kind: 'bool', default: true },
		price: { kind: 'decimal', scale: 2, optional: true },
		commission_factor: { kind: 'decimal', scale: 4, optional: true }
	},
	outputs: { default: { fields: 'all' } },
	update: { columns: { products: ['commission_factor'] } },
	syncs: {
		// one way in from the ledger database, every 15 minutes by default
		ledger: {
			with: 'kingdee',
			read: function* (_, ctx) {
				const { rows } = yield* ctx.request({
					op: 'read',
					table: { schema: 'dbo', name: 'products' },
					columns: ['code', 'name']
				});
				return {
					rows: rows.map((r) => ({
						$id: String(r['code']),
						external_code: String(r['code']),
						name: String(r['name'])
					})),
					snapshot: 'end',
					more: false
				};
			}
		}
	}
});

export const entries = model('entries', {
	description: "Calendar entries mirrored from members' calendars",
	record_label: 'record.subject',
	key: ['account', 'calendar_id', 'external_id'],
	fields: {
		account: { kind: 'ref', to: 'sys_integration', where: { integration: { eq: 'calendar' } } },
		calendar_id: { kind: 'text' },
		external_id: { kind: 'text' },
		subject: { kind: 'text' },
		event_status: { kind: 'enum', values: ['confirmed', 'tentative', 'cancelled'] },
		filed: { kind: 'bool', default: false }
	},
	outputs: { default: { fields: 'all' } },
	update: { columns: { entries: ['filed'] } },
	syncs: {
		// the calendar driver pushes events; one cursor per chosen calendar
		calendar: {
			with: 'calendar',
			partitions: 'calendars',
			read: function* ({ items, partition }) {
				return {
					rows: items.map((e) => ({
						$id: e.id,
						calendar_id: partition ?? '',
						external_id: e.id,
						subject: e.summary ?? '(untitled)',
						event_status: e.status
					}))
				};
			}
		}
	}
});

export const rating = custom_field({
	description: 'A score with an optional note',
	shape: {
		kind: 'object',
		fields: { score: { kind: 'int', min: 1, max: 5 }, note: { kind: 'text', optional: true } }
	},
	validate: (v) => (v.score === 5 && v.note === undefined ? 'A top score needs a note.' : undefined)
});

/**
 * The smallest literal a corpus case re-declares a model's bodies on: its data is checked against itself, its bodies are
 * typed by the name it is declared under.
 */
export const base = {
	description: 'x',
	record_label: 'record.note',
	fields: { note: { kind: 'text', optional: true } },
	outputs: { default: { fields: 'all' } }
} as const;
