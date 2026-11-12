// @norbital-ai/store: a schema as a value, and the SQL every read, write and migration over it emits, with the
// decoders of its rows. It never connects to a database: the caller executes each statement.
export * from './catalog.ts';
export * from './cursor.ts';
export * from './decode.ts';
export * from './database.ts';
export * from './errors.ts';
export * from '@norbital-ai/std/hash';
export * from './ir.ts';
export * from './limits.ts';
export * from './values.ts';
export {
	compile,
	compile_gets,
	encode_cursor,
	grant_sql,
	OVER,
	where_sql,
	type Compiled,
	type CompileOptions,
	type Probe,
	type Scope,
	type Sql
} from './read/sql.ts';
export * from './read/values.ts';
export * from './write/predicate.ts';
export * from './schema/spec.ts';
export { schema_snapshot, type SchemaSnapshot } from './schema/snapshot.ts';
export {
	check_of,
	RANK,
	SchemaObjectSchema,
	MINOR_FN,
	PG,
	col_type,
	schema_objects,
	path_text,
	constraint_index,
	type ConstraintMeta,
	type SchemaObject,
	type Json
} from './schema/ddl.ts';
export * from './schema/plan.ts';
export { search_functions } from './schema/search.ts';
export { answer, arms_fit, total_of } from './read/page.ts';
export { null_row_sql } from './write/row.ts';
export {
	compile_write,
	type CompiledWrite,
	type InlineChange,
	type WireRow,
	type WriteIR,
	type WriteOptions
} from './write/sql.ts';
export * from './store.ts';
export * from './types.ts';
export * from './migrate.ts';
export * from './migration-generate.ts';
export * from './log/spec.ts';
export * from './log/ddl.ts';
export * from './log/statements.ts';
export * from './log/migrations.ts';
