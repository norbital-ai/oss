// @norbital-ai/store: a schema as a value, and the SQL every read, write and migration over it emits, with the
// decoders of its rows. It never connects to a database: the caller executes each statement.
export * from './catalog.ts';
export * from './cursor.ts';
export * from './decode.ts';
export * from './database.ts';
export * from './errors.ts';
export * from './hash.ts';
export * from './ir.ts';
export * from './limits.ts';
export * from './values.ts';
export {
	compile,
	compileGets,
	encodeCursor,
	grantSql,
	OVER,
	whereSql,
	type Compiled,
	type CompileOptions,
	type Probe,
	type Scope,
	type Sql
} from './read/sql.ts';
export * from './read/values.ts';
export * from './write/predicate.ts';
export * from './schema/spec.ts';
export {
	checkOf,
	RANK,
	SchemaObjectSchema,
	MINOR_FN,
	PG,
	colType,
	schemaObjects,
	pathText,
	constraintIndex,
	type ConstraintMeta,
	type SchemaObject,
	type Json
} from './schema/ddl.ts';
export * from './schema/plan.ts';
export { searchFunctions } from './schema/search.ts';
export { answer, armsFit, totalOf } from './read/page.ts';
export { nullRowSql } from './write/row.ts';
export {
	compileWrite,
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
