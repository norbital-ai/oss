// The actual page augmentation must retain workspace names through ui's value constraints.
import { Effect } from 'effect';
import { expectTypeOf } from 'vitest';
import {
	Form,
	Table,
	type AutomationInputOf,
	type AutomationKey,
	type RecordOf,
	type RowOf,
	type UiContext,
	type Workspace
} from '@norbital-ai/ui';
import type { ViewNames } from '../../src/decl/ctx.ts';
import type { Id, ListRow, Row, StartInput } from '../../src/index.ts';
import type { AutomationName } from '../../src/decl/names.ts';
import type { PageContext } from '../../src/page/index.ts';
import './registry.ts';

declare const ctx: PageContext;
declare const ui: UiContext;

expectTypeOf<Workspace['names']>().toEqualTypeOf<ViewNames>();
expectTypeOf<AutomationKey>().toEqualTypeOf<AutomationName>();
expectTypeOf<RowOf<'orders'>>().toEqualTypeOf<ListRow<'orders'>>();
expectTypeOf<RecordOf<'sites'>>().toEqualTypeOf<Row<'sites'>>();
expectTypeOf<AutomationInputOf<'render'>>().toEqualTypeOf<StartInput<'render'>>();

declare const order: Id<'orders'>;
declare const site: Row<'sites'>;

Form(null, { ctx: ui, of: 'sites', mode: 'view', record: site, fields: ['name', 'rating', 'checklist'] });
Form(null, { ctx: ui, of: { automation: 'render' }, values: { order }, fields: ['order'] });
Form(null, { ctx: ui, of: { automation: 'body' }, values: { n: 1 }, fields: ['n'] });
// @ts-expect-error An unknown model never falls back to an arbitrary string.
Form(null, { ctx: ui, of: 'missing_model' });
// @ts-expect-error An unknown automation never falls back to an arbitrary string.
Form(null, { ctx: ui, of: { automation: 'missing_automation' } });
// @ts-expect-error Native sync controls are not flat automation forms.
Form(null, { ctx: ui, of: { automation: 'products.sync.ledger' } });
// @ts-expect-error The generated automation input keeps its branded order id.
Form(null, { ctx: ui, of: { automation: 'render' }, values: { order: 1 } });
// @ts-expect-error Automation values use their declared fields at the top level.
Form(null, { ctx: ui, of: { automation: 'render' }, values: { input: { order } } });
// @ts-expect-error Automation forms accept their input fields only.
Form(null, { ctx: ui, of: { automation: 'render' }, fields: ['missing_field'] });
// @ts-expect-error A record target belongs in the explicit automation input.
Form(null, { ctx: ui, of: { automation: 'render' }, id: order });

ctx.query({ sites: { fields: ['name', 'rating', 'checklist'], limit: 1 } }).pipe(
	Effect.map(({ sites }) => {
		Table(null, { ctx: ui, of: sites.rows, columns: ['name', 'rating', 'checklist'] });
		// @ts-expect-error A picked row never gains fields through a loose ui registry fallback.
		Table(null, { ctx: ui, of: sites.rows, columns: ['due'] });
	})
);
