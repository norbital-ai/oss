// Full schema planner & builder (includes multilingual search functions; kept separate from cell runtime classification).
import { Effect } from 'effect';
import type { StoreError } from '../errors.ts';
import { schema_objects } from './objects.ts';
import { plannerWithObjects, statements, type Plan } from './plan.ts';
import type { SchemaSpec } from './spec.ts';

/** A complete executable plan uses every original SQL definition. */
export const plan = /*#__PURE__*/ plannerWithObjects(schema_objects);

/** The statements that build `schema` from nothing: what `verify`'s second scratch database runs. */
export const build = (schema: SchemaSpec): Effect.Effect<readonly string[], StoreError> =>
	Effect.map(plan(null, schema), (p: Plan) => statements(p).map((s) => s.sql));
