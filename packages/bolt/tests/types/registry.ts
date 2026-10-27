// Literal names generated from the type corpus declarations; local declaration probes add their named shapes.
import type { Check, Verify } from '../../src/index.ts';

declare module '../../src/index.ts' {
	interface Names {
		apps: {
			sales: {};
			portal: {};
		};
		automations: {
			orders_submit: {
				spec: {
					description: 'Submit this order';
					input: { target: { kind: 'id'; of: 'orders' } };
					runAs: 'trigger';
				};
			};
			orders_renote: {
				spec: {
					description: 'Set a note on many orders';
					input: {
						ids: { kind: 'list'; of: { kind: 'id'; of: 'orders' } };
						note: { kind: 'text' };
					};
					output: { kind: 'int' };
					runAs: 'trigger';
				};
			};
			order_lines_pay: {
				spec: {
					description: 'Pay';
					input: {
						p: {
							kind: 'union';
							by: 'method';
							arms: { card: { last4: { kind: 'text' } }; bank: { iban: { kind: 'text' } } };
						};
						split: { kind: 'record'; of: { kind: 'decimal'; scale: 2 } };
					};
					output: { kind: 'text' };
					runAs: 'trigger';
				};
			};
			order_lines_chase: {
				spec: {
					description: 'Chase the lines';
					input: {};
					runAs: 'trigger';
				};
			};
			customers_return_row: {
				spec: {
					description: 'One native row';
					input: {};
					output: { kind: 'row'; of: 'customers' };
					runAs: 'trigger';
				};
			};
			sweep: { spec: { description: 'x'; runAs: readonly ['sales_rep'] } };
			nightly: {
				spec: {
					description: 'Nightly order digest';
					runAs: readonly ['sales_rep'];
					on: {
						cron: '0 2 * * *';
					};
					output: {
						kind: 'int';
					};
				};
			};
			follow_up: {
				spec: {
					description: 'Chase an order three days after it is placed';
					runAs: readonly ['sales_rep'];
					on: readonly [
						{
							created: 'orders';
							delay: '3d';
							where: {
								status: {
									eq: 'draft';
								};
							};
						},
						{
							updated: 'orders';
							fields: readonly ['status', 'total'];
						}
					];
					retry: {
						attempts: 3;
						backoff: '1min';
					};
					concurrency: {
						max: 1;
					};
				};
			};
			render: {
				spec: {
					description: 'Render an order confirmation';
					runAs: 'trigger';
					input: {
						order: {
							kind: 'id';
							of: 'orders';
						};
					};
					output: {
						kind: 'file';
						accept: readonly ['application/pdf'];
						max: '5MiB';
					};
				};
			};
			inbound_hook: {
				spec: {
					description: 'Payment provider callback';
					runAs: readonly ['sales_rep'];
					on: {
						webhook: '/payments';
						verify: {
							scheme: 'stripe';
							secret: 'HOOK_SECRET';
						};
					};
					input: {
						order: {
							kind: 'text';
						};
					};
				};
			};
			body: {
				spec: {
					description: 'x';
					runAs: readonly ['sales_rep'];
					input: {
						n: {
							kind: 'int';
						};
					};
					output: {
						kind: 'text';
					};
				};
			};
			trig: {
				spec: {
					description: 'x';
					runAs: 'trigger';
				};
			};
		};
		exposures: {
			customers: {
				read: {
					customers: { fields: 'all' };
				};
				create: {
					columns: { customers: readonly ['name', 'email', 'tier'] };
					filled: { customers: readonly ['name'] };
					transform: true;
				};
				update: {
					columns: { customers: readonly ['name', 'email', 'tier', 'tags'] };
				};
				delete: { check: true };
				syncs: {
					crm: {
						with: 'erp';
						every: '1h';
						read: true;
						write: true;
					};
				};
			};
			orders: {
				read: {
					orders: { fields: 'all' };
					'orders.customer': { fields: readonly ['name', 'tier'] };
					'orders.lines': { fields: 'all' };
				};
				create: {
					columns: {
						orders: readonly ['customer', 'note', 'due'];
						'orders.lines': readonly ['item', 'qty', 'price'];
					};
					filled: { orders: readonly ['note'] };
					transform: true;
				};
				update: {
					columns: {
						orders: readonly ['status', 'note', 'due', 'placed_at'];
						'orders.lines': readonly ['item', 'qty', 'price'];
					};
					transform: true;
				};
				delete: {
					check: true;
				};
				notify: true;
				syncs: {
					ledger: {
						with: 'kingdee';
						write: true;
					};
					sheet: {
						with: 'file';
						parser: readonly [
							'xlsx',
							'csv',
							{
								type: 'application/vnd.ms-excel';
								extensions: readonly ['.xls'];
							}
						];
						schema: {
							customer: {
								kind: 'text';
								label: 'Customer';
							};
							note: {
								kind: 'text';
								optional: true;
							};
						};
						context: {
							since: {
								kind: 'date';
							};
						};
						read: true;
						write: true;
					};
				};
			};
			order_lines: {
				read: {
					order_lines: { fields: 'all' };
				};
			};
			notices: {
				read: {
					notices: { fields: 'all' };
				};
				syncs: {
					mail: {
						with: 'support_mail';
						read: true;
					};
				};
			};
			notice_notes: {
				read: {
					notice_notes: { fields: 'all' };
				};
				create: {
					columns: { notice_notes: readonly ['notice', 'note'] };
				};
				update: {
					columns: { notice_notes: readonly ['note'] };
				};
				syncs: {
					sheet: {
						with: 'file';
						parser: readonly ['csv'];
						schema: {
							code: {
								kind: 'text';
							};
							note: {
								kind: 'text';
							};
						};
						context: {
							notice: {
								kind: 'id';
								of: 'notices';
							};
						};
						read: true;
						write: true;
					};
				};
			};
			sites: {
				read: {
					sites: { fields: readonly ['name', 'location', 'customer', 'open', 'rating', 'checklist'] };
				};
				update: {
					columns: { sites: readonly ['name', 'location'] };
				};
			};
			products: {
				read: {
					products: { fields: 'all' };
				};
				update: {
					columns: { products: readonly ['commission_factor'] };
				};
				syncs: {
					ledger: {
						with: 'kingdee';
						read: true;
					};
				};
			};
			entries: {
				read: {
					entries: { fields: 'all' };
				};
				update: {
					columns: { entries: readonly ['filed'] };
				};
				syncs: {
					calendar: {
						with: 'calendar';
						partitions: 'calendars';
						read: true;
					};
				};
			};
		};
		customFields: {
			rating: {
				spec: {
					description: 'A score with an optional note';
					shape: {
						kind: 'object';
						fields: {
							score: {
								kind: 'int';
								min: 1;
								max: 5;
							};
							note: {
								kind: 'text';
								optional: true;
							};
						};
					};
				};
			};
			variant: {
				spec: {
					description: 'x';
					shape: {
						kind: 'union';
						by: 'type';
						arms: {
							a: {
								n: {
									kind: 'int';
								};
							};
							b: {
								s: {
									kind: 'text';
								};
							};
						};
					};
				};
			};
			scalar_variant: {
				spec: {
					description: 'x';
					shape: {
						kind: 'object';
						fields: {
							value: {
								kind: 'union';
								of: readonly [
									{
										kind: 'bool';
									},
									{
										kind: 'number';
									},
									{
										kind: 'text';
									}
								];
							};
						};
					};
				};
			};
		};
		envoys: {
			desk: {
				name: 'Norbius';
				audience: 'private';
				policies: readonly ['sales_rep'];
				groupMessages: 'mention_or_reply';
				delegation: 'disabled';
				task: 'Keep orders up to date from what people report.';
			};
		};
		hostTools: {
			browser: true;
		};
		integrations: {
			erp: {
				spec: {
					description: 'The ERP API.';
					driver: 'http';
					configuration: {
						baseUrl: {
							kind: 'text';
							format: 'url';
						};
						room: {
							kind: 'text';
							default: 'general';
						};
						topic: {
							kind: 'text';
							optional: true;
						};
						mute: {
							kind: 'bool';
							optional: true;
							default: false;
						};
					};
					credential: {
						token: {
							kind: 'text';
							label: 'API token';
						};
						signingSecret: {
							kind: 'text';
							label: 'Webhook signing secret';
						};
					};
					http: {
						baseUrl: 'baseUrl';
						auth: {
							bearer: 'token';
						};
					};
					webhook: {
						verify: {
							scheme: 'standard';
							secret: 'signingSecret';
						};
					};
					rate: '10/s';
				};
			};
			kingdee: {
				spec: {
					description: 'An accounting database.';
					driver: 'sqlserver';
					credential: {
						connection: {
							kind: 'text';
							label: 'Connection string';
						};
					};
					configuration: {
						maxLagMinutes: {
							kind: 'int';
							min: 1;
							default: 15;
						};
						databases: {
							kind: 'text';
							many: true;
							default: readonly [];
						};
					};
				};
			};
			support_mail: {
				spec: {
					description: 'The support mailbox.';
					driver: 'email';
				};
			};
			calendar: {
				spec: {
					description: "A member's calendar.";
					driver: 'calendar';
					oauth: {
						client: 'CALENDAR_CLIENT';
						secret: 'CALENDAR_SECRET';
					};
					configuration: {
						calendars: {
							kind: 'text';
							many: true;
							default: readonly [];
						};
					};
				};
			};
		};
		mcp: {
			erp: {
				description: 'Product documentation';
				url: 'MCP_URL';
				tools: readonly ['search_docs'];
			};
		};
		layers: {
			orders: { 'orders.customer': 'customers'; 'orders.lines': 'order_lines' };
		};
		models: {
			customers: {
				description: 'Buyers';
				label: 'name';
				computed: {
					name_upper: {
						kind: 'text';
						expr: {
							upper: {
								field: 'name';
							};
						};
					};
					email_lower: {
						kind: 'text';
						expr: {
							lower: {
								field: 'email';
							};
						};
					};
					email_label: {
						kind: 'text';
						expr: {
							concat: readonly [
								{
									field: 'email';
								},
								' contact'
							];
						};
					};
					email_default: {
						kind: 'text';
						expr: {
							coalesce: readonly [
								{
									field: 'email';
								},
								'unknown'
							];
						};
					};
					email_chain: {
						kind: 'text';
						expr: {
							upper: {
								field: 'email_lower';
							};
						};
					};
				};
				fields: {
					name: {
						kind: 'text';
					};
					email: {
						kind: 'text';
						format: 'email';
						optional: true;
					};
					tier: {
						kind: 'enum';
						values: readonly ['basic', 'gold'];
						default: 'basic';
					};
					tags: {
						kind: 'text';
						many: true;
						optional: true;
					};
					order_count: {
						kind: 'count';
						of: 'orders';
					};
				};
				search: {
					text: readonly ['name'];
				};
			};
			orders: {
				description: 'Sales orders';
				label: readonly ['number', 'customer'];
				index: readonly ['customer', 'due'];
				computed: {
					due_soon: {
						kind: 'date';
						expr: {
							plusDays: readonly [
								{
									field: 'due';
								},
								-7
							];
						};
					};
				};
				check: {
					has_customer: {
						customer: {
							isNull: false;
						};
					};
				};
				fields: {
					number: {
						kind: 'seq';
						pattern: 'SO-{0000}';
					};
					status: {
						kind: 'state';
						initial: 'draft';
						states: {
							draft: {
								to: readonly ['submitted'];
							};
							submitted: {
								to: readonly ['ordered', 'draft'];
								edit: readonly ['status', 'note', 'lines'];
							};
							ordered: {
								edit: 'none';
							};
						};
					};
					note: {
						kind: 'text';
						optional: true;
					};
					due: {
						kind: 'date';
						optional: true;
					};
					placed_at: {
						kind: 'instant';
						optional: true;
					};
					total: {
						kind: 'sum';
						of: 'lines.amount';
						where: {
							qty: {
								gt: 0;
							};
						};
					};
					line_count: {
						kind: 'count';
						of: 'lines';
					};
					colour: {
						kind: 'vector';
						dim: 3;
						metric: 'l2';
						optional: true;
					};
				};
				search: {
					text: readonly ['note'];
					indexes: {
						by_colour: {
							description: 'Orders of a similar colour';
							dim: 3;
							metric: 'l2';
							input: {
								lab: {
									kind: 'vector';
									dim: 3;
									metric: 'l2';
								};
							};
							field: 'colour';
							candidates: 4;
							rerank: true;
						};
					};
				};
			};
			order_lines: {
				description: 'Lines of an order';
				label: 'item';
				computed: {
					amount: {
						kind: 'money';
						expr: {
							round: readonly [
								{
									times: readonly [
										{
											field: 'price';
										},
										{
											field: 'qty';
										}
									];
								},
								2
							];
						};
					};
				};
				fields: {
					item: {
						kind: 'text';
					};
					qty: {
						kind: 'decimal';
						scale: 3;
					};
					price: {
						kind: 'money';
					};
				};
			};
			notices: {
				description: 'Supplier notices mirrored from the inbox';
				label: 'subject';
				key: readonly ['inbox', 'message_id'];
				fields: {
					message_id: {
						kind: 'text';
					};
					subject: {
						kind: 'text';
					};
					received_at: {
						kind: 'instant';
					};
				};
				search: {
					text: readonly ['subject'];
					semantic: {
						fields: readonly ['subject'];
						model: 'text_small';
						dim: 1536;
					};
				};
			};
			notice_notes: {
				description: 'What we add about a notice';
				label: 'notice';
				unique: readonly [
					{
						fields: readonly ['notice'];
					}
				];
				fields: {
					note: {
						kind: 'text';
					};
				};
			};
			sites: {
				description: 'Customer sites';
				label: 'name';
				noOverlap: readonly [
					{
						key: readonly ['name'];
						period: 'open';
					}
				];
				fields: {
					name: {
						kind: 'text';
						max: 120;
					};
					zone: {
						kind: 'text';
						format: 'zone';
					};
					notes: {
						kind: 'text';
						format: 'markdown';
						optional: true;
					};
					location: {
						kind: 'point';
						optional: true;
					};
					open: {
						kind: 'period';
						of: 'date';
					};
					opens_at: {
						kind: 'time';
						optional: true;
					};
					slot: {
						kind: 'duration';
						default: '30min';
					};
					photos: {
						kind: 'file';
						accept: readonly ['image/*'];
						max: '5MiB';
						multiple: true;
						optional: true;
					};
					checklist: {
						kind: 'json';
						shape: {
							kind: 'list';
							of: {
								kind: 'object';
								fields: {
									item: {
										kind: 'text';
									};
									done: {
										kind: 'bool';
									};
								};
							};
						};
					};
					rating: {
						kind: 'custom';
						of: 'rating';
						optional: true;
					};
					budget: {
						kind: 'money';
						currency: 'EUR';
						optional: true;
					};
				};
			};
			products: {
				description: 'Products from the ledger';
				label: 'name';
				key: readonly ['source', 'external_code'];
				fields: {
					external_code: {
						kind: 'text';
					};
					name: {
						kind: 'text';
					};
					active: {
						kind: 'bool';
						default: true;
					};
					price: {
						kind: 'decimal';
						scale: 2;
						optional: true;
					};
					commission_factor: {
						kind: 'decimal';
						scale: 4;
						optional: true;
					};
				};
			};
			entries: {
				description: "Calendar entries mirrored from members' calendars";
				label: 'subject';
				key: readonly ['account', 'calendar_id', 'external_id'];
				fields: {
					calendar_id: {
						kind: 'text';
					};
					external_id: {
						kind: 'text';
					};
					subject: {
						kind: 'text';
					};
					event_status: {
						kind: 'enum';
						values: readonly ['confirmed', 'tentative', 'cancelled'];
					};
					filed: {
						kind: 'bool';
						default: false;
					};
				};
			};
		};
		policies: {
			sales_rep: {
				description: 'Sell to our customers';
				grants: {
					orders: {
						read: {
							orders: {
								where: { owner: { eq: { actor: 'id' } } };
								fields: readonly ['number', 'status', 'customer', 'note', 'due', 'total', 'owner'];
							};
							'orders.customer': { fields: readonly ['name'] };
						};
						history: true;
						create: {
							columns: { orders: readonly ['customer', 'note']; 'orders.lines': readonly ['item', 'qty'] };
							check: true;
						};
						update: { columns: { orders: readonly ['status', 'note'] }; check: true };
						delete: { check: true };
						moves: {
							status: readonly ['draft->submitted', 'submitted->draft'];
						};
					};
					customers: {
						read: {
							customers: {
								where: { orders: { some: { owner: { eq: { actor: 'id' } } } } };
								fields: readonly ['name', 'tier'];
							};
						};
						update: true;
					};
					notices: {
						read: true;
					};
					sites: {
						read: {
							sites: {
								where: { customer: { in: { actor: { scopes: 'sales_rep' } } } };
								fields: readonly ['name', 'open'];
							};
						};
					};
					sys_user: {
						read: {
							team: {
								in: {
									actor: 'teamTree';
								};
							};
						};
						fields: readonly ['name', 'email'];
					};
				};
				automations: readonly ['nightly', 'products.sync.ledger', 'orders_submit', 'orders_renote'];
				capabilities: {
					apps: readonly ['sales'];
					tools: readonly ['browser'];
					mcp: readonly ['erp'];
					skills: readonly ['quoting'];
				};
				limits: {
					act: '600/min';
					agent: {
						rate: '100/h';
						per: 'actor';
					};
					read: readonly [
						{
							rate: '3000/min';
							per: 'actor';
						},
						{
							rate: '600/min';
							per: 'ip';
						}
					];
					convert: '10/min';
					'envoys.receive': readonly [
						{
							rate: '8/min';
							per: 'sender';
						},
						{
							rate: '300/min';
							per: 'subject';
						}
					];
					'envoys.unrecognised': '1/15min';
				};
			};
			// reads orders as sales_rep does, and narrows `orders.lines`, which sales_rep reads in full by not naming it
			auditor: {
				description: 'Audit orders';
				grants: {
					orders: {
						read: {
							orders: {
								fields: readonly ['number', 'status', 'customer', 'note', 'due', 'total', 'owner'];
							};
							'orders.customer': { fields: readonly ['name'] };
							'orders.lines': { fields: readonly ['item'] };
						};
					};
				};
			};
		};
		relationships: {
			'customers.hotline': {
				to: 'sys_integration';
				optional: true;
				where: {
					integration: {
						eq: 'whatsapp';
					};
				};
			};
			'orders.customer': {
				to: 'customers';
				inverse: 'orders';
			};
			'orders.owner': {
				to: 'sys_user';
				optional: true;
				default: {
					actor: 'id';
				};
			};
			'orders.ledger': {
				to: 'sys_integration';
				optional: true;
				where: {
					integration: {
						eq: 'kingdee';
					};
				};
			};
			'order_lines.order': {
				to: 'orders';
				inverse: 'lines';
				owned: true;
			};
			'notices.inbox': {
				to: 'sys_integration';
				where: {
					integration: {
						eq: 'support_mail';
					};
				};
			};
			'notice_notes.notice': {
				to: 'notices';
				inverse: 'notes';
				owned: true;
			};
			'notice_notes.integration': {
				to: 'sys_integration';
				optional: true;
			};
			'sites.customer': {
				to: 'customers';
				optional: true;
				onDelete: 'setNull';
				inverse: 'sites';
				where: {
					tier: {
						eq: 'gold';
					};
				};
			};
			'products.source': {
				to: 'sys_integration';
				where: {
					integration: {
						eq: 'kingdee';
					};
				};
			};
			'entries.account': {
				to: 'sys_integration';
				where: {
					integration: {
						eq: 'calendar';
					};
				};
			};
		};
		secrets: {
			ERP_URL: {
				label: 'ERP base URL';
			};
			ERP_TOKEN: {
				label: 'ERP API token';
			};
			MCP_URL: {
				label: 'Docs MCP server';
			};
			HOOK_SECRET: {
				label: 'Webhook signing secret';
				description: 'Signs inbound webhooks.';
			};
			CALENDAR_CLIENT: {
				label: 'Calendar OAuth client';
			};
			CALENDAR_SECRET: {
				label: 'Calendar OAuth secret';
			};
		};
		skills: {
			quoting: true;
		};
		teams: {
			finance: readonly [];
			sales: readonly ['sales_rep'];
		};
		workspace: {
			tz: 'Asia/Singapore';
			locale: 'en-SG';
			currency: 'SGD';
			apps: readonly ['sales', 'portal'];
			ai: {
				models: readonly ['default', 'fast', 'strong'];
				default: 'default';
				embeddings: readonly ['text_small'];
			};
			convert: {
				to: readonly ['pdf', 'docx'];
			};
			csp: {
				connect: readonly ['https://huggingface.co'];
			};
			connections: {
				erp: {
					integration: 'erp';
				};
				ledger_main: {
					integration: 'kingdee';
				};
				support: {
					integration: 'support_mail';
				};
				whatsapp: {
					integration: 'whatsapp';
					envoy: 'desk';
				};
			};
		};
		pages: { sales: 'overview' | 'orders'; portal: 'tickets' };
		groups: { ops: 'sales' | 'portal' };
	}
}

export const __verify: Check<Verify> = true;
