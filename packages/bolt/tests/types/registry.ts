// The hand-written names index for the type corpus: what the compiler generates into `.norbital/names.ts`.
import type * as c from './fixture/collections.ts';
import type * as m from './fixture/models.ts';
import type relationships from './fixture/relationships.ts';
import type * as rt from './fixture/runtime.ts';

declare module '../../src/index.ts' {
	interface Names {
		workspace: typeof rt.ws;
		secrets: typeof rt.secretNames;
		models: {
			customers: typeof m.customers;
			orders: typeof m.orders;
			order_lines: typeof m.order_lines;
			notices: typeof m.notices;
			notice_notes: typeof m.notice_notes;
			sites: typeof m.sites;
			products: typeof m.products;
			entries: typeof m.entries;
		};
		relationships: typeof relationships;
		collections: {
			customers: typeof c.customers;
			orders: typeof c.orders;
			order_lines: typeof c.order_lines;
			notices: typeof c.notices;
			notice_notes: typeof c.notice_notes;
			sites: typeof c.sites;
			products: typeof c.products;
			entries: typeof c.entries;
		};
		integrations: {
			erp: typeof rt.erp;
			kingdee: typeof rt.kingdee;
			support_mail: typeof rt.support_mail;
			company_chat: typeof rt.company_chat;
			calendar: typeof rt.calendar;
		};
		fed: {
			notices: 'support_mail.notices';
			products: 'kingdee.products';
			entries: 'calendar.entries';
		};
		envoys: { desk: typeof rt.desk };
		customFields: { rating: typeof m.rating };
		teams: { Finance: unknown; Sales: unknown };
		policies: { sales_rep: typeof import('./access.ts').salesRep };
		apps: { sales: unknown; portal: unknown };
		automations: {
			nightly: typeof rt.nightly;
			follow_up: typeof rt.follow_up;
			render: typeof rt.render;
			inbound_hook: typeof rt.inbound_hook;
		};
		mcp: { erp: typeof rt.erp_mcp };
		pages: { sales: 'overview' | 'orders'; portal: 'tickets' };
		groups: { ops: 'sales' | 'portal' };
		skills: { quoting: unknown };
		hostTools: { browser: unknown };
	}
}

// The generated `__verify` line: every cross-file declaration error of the workspace fails here.
import type { Check, Verify } from '../../src/index.ts';
export const __verify: Check<Verify> = true;
