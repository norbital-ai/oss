// @norbital-ai/store: a schema as a value, and the SQL every read, write and migration over it emits, with the
// decoders of its rows. It never connects to a database: the caller executes each statement.
export {
	field_info,
	catalog_of,
	catalog_for,
	exposed_field,
	default_fields,
	stored_fields,
	type FieldInfo,
	type ModelInfo,
	type ExposureInfo,
	type OutputInfo,
	type Catalog,
	SEARCH_COLUMN,
	RECORD_LABEL_COLUMN,
	EMBEDDING_COLUMN,
	SEMANTIC,
	index_column,
	SYSTEM_COLUMNS,
	SYSTEM_COLUMN_SET,
	KindSpec,
	CatalogTable,
	CatalogExposure,
	DEFAULT_OUTPUT,
	exposure_of
} from './catalog.ts';
export { q, literal } from './sql.ts';
export { type Cursor, CursorValue } from './cursor.ts';
export {
	argument_list,
	can_aggregate_where,
	where,
	decode_view,
	page,
	UNSORTABLE,
	order,
	select,
	read,
	get,
	aggregate,
	semantic,
	similar
} from './decode.ts';
export { postgres_maintenance, sqlite_ownership } from './database.ts';
export { StoreError } from './errors.ts';
export { sha256, to_hex, sha256_hex, canonical } from './hash.ts';
export {
	type Var,
	type Operand,
	type Arg,
	type Cmp,
	type Pred,
	type Order,
	type SelectIR,
	type RelSelectIR,
	type ListRead,
	type ReadIR
} from './ir.ts';
export { type Json } from './values.ts';
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
export { database_value, cells, comparable } from './read/values.ts';
export { type Binder, own_pred_sql } from './write/predicate.ts';
export {
	FieldSpec,
	COMPUTED_KINDS,
	type ComputedKind,
	type Expr,
	ExprSchema,
	TableSpec,
	SchemaSpec,
	HistoryTableMetadata
} from './schema/spec.ts';
export { schema_snapshot, type SchemaSnapshot } from './schema/snapshot.ts';
export {
	check_of,
	RANK,
	MINOR_FN,
	schema_objects,
	constraint_index,
	type ConstraintMeta,
	type SchemaObject
} from './schema/ddl.ts';
export { statements, type Plan, plan, destructive_steps } from './schema/plan.ts';
export { search_functions } from './schema/search.ts';
export { answer, total_of } from './read/page.ts';
export { null_row_sql } from './write/row.ts';
export { store, type ResultRow, type Statement, table, schema, type Store } from './store.ts';
export { type Select, type Row, type Where, type Page } from './types.ts';
export {
	migration_guard,
	executable,
	migration_statements,
	impact_count,
	physical_definitions_of,
	type MigrationFile,
	type Applied,
	AppliedRow,
	SquashReceipt,
	MigrationLock,
	MIGRATIONS_TABLE,
	record_applied,
	APPLIED,
	MIGRATION_GUARD_CODES,
	checksum_of,
	snapshot_of,
	read_snapshot,
	read_lock,
	lock_of,
	check_file,
	archive_of,
	physical_hash,
	type PhysicalDefinitions,
	read_physical_definitions,
	check_squash_sources,
	verify_squash,
	pending,
	migration_status,
	current,
	INTROSPECT,
	IntrospectRow,
	verify,
	build
} from './migrate.ts';
export { destroy_namespace, generate, generate_squash } from './migration-generate.ts';
export { AppendOnlyLogSpec, log_snapshot } from './log/spec.ts';
export { log_ddl } from './log/ddl.ts';
export { log_statements } from './log/statements.ts';
export { log_introspect, log_migration_guard, log_current, verify_log } from './log/migrations.ts';
