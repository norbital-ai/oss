// Native catalogue introspection SQL; the cell build packs these exact bytes.
export const INTROSPECT = `select 'table ' || c.relname || ' ' || c.relkind::text || ' ' || c.relpersistence::text
		|| ' rls ' || c.relrowsecurity::text || ' force ' || c.relforcerowsecurity::text
		|| case when c.relkind in ('v', 'm') then ' definition ' || pg_get_viewdef(c.oid, true) else '' end as line,
		'table' as kind, c.relname as owner
	from pg_class c join pg_namespace n on n.oid = c.relnamespace
	where n.nspname = current_schema() and c.relkind in ('r', 'p', 'f', 'v', 'm') and c.relname <> 'store_migration'
	and not exists (select 1 from pg_depend x where x.classid = 'pg_class'::regclass and x.objid = c.oid and x.deptype = 'e')
union all
select 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
		|| case when a.attnotnull then ' not null' else '' end
		|| coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
		|| case when a.attidentity <> '' then ' identity ' || a.attidentity::text else '' end
		|| case when a.attgenerated = 's' then ' generated' else '' end as line,
		'column', c.relname
	from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
	left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
	where n.nspname = current_schema() and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and c.relname <> 'store_migration'
	and not exists (select 1 from pg_depend x where x.classid = 'pg_class'::regclass and x.objid = c.oid and x.deptype = 'e')
union all
select 'constraint ' || c.relname || '.' || k.conname || ' ' || pg_get_constraintdef(k.oid), 'constraint', c.relname
	from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
	-- Column nullability is compared above; generated NOT NULL names survive table and field renames.
	where n.nspname = current_schema() and c.relname <> 'store_migration' and k.contype <> 'n'
	and not exists (select 1 from pg_depend x where x.classid = 'pg_class'::regclass and x.objid = c.oid and x.deptype = 'e')
union all
select 'index ' || i.indexname || ' ' || replace(i.indexdef, i.indexname, ''), 'index', i.tablename
	from pg_indexes i
	join pg_namespace n on n.nspname = i.schemaname
	join pg_class c on c.relnamespace = n.oid and c.relname = i.tablename
	join pg_class ix on ix.relnamespace = n.oid and ix.relname = i.indexname
	where i.schemaname = current_schema() and i.tablename <> 'store_migration'
	and not exists (select 1 from pg_depend x where x.classid = 'pg_class'::regclass and x.objid in (c.oid, ix.oid) and x.deptype = 'e')
union all
select 'function ' || p.proname || ' ' || pg_get_functiondef(p.oid), 'function',
		p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
	from pg_proc p join pg_namespace n on n.oid = p.pronamespace
	where n.nspname = current_schema() and p.prokind in ('f', 'p')
	and not exists (select 1 from pg_depend x where x.classid = 'pg_proc'::regclass and x.objid = p.oid and x.deptype = 'e')
union all
select 'trigger ' || c.relname || '.' || t.tgname || ' ' || pg_get_triggerdef(t.oid), 'trigger', c.relname || '.' || t.tgname
	from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
	where n.nspname = current_schema() and c.relname <> 'store_migration' and not t.tgisinternal
	and not exists (select 1 from pg_depend x where (x.classid = 'pg_class'::regclass and x.objid = c.oid or x.classid = 'pg_trigger'::regclass and x.objid = t.oid) and x.deptype = 'e')
union all
select 'extension ' || e.extname, 'extension', e.extname
	from pg_extension e join pg_namespace n on n.oid = e.extnamespace where n.nspname = current_schema()
union all
select 'sequence ' || coalesce(t.relname || '.' || a.attname, c.relname)
		|| ' ' || format_type(s.seqtypid, null)
		|| ' start ' || s.seqstart::text || ' increment ' || s.seqincrement::text
		|| ' min ' || s.seqmin::text || ' max ' || s.seqmax::text
		|| ' cache ' || s.seqcache::text || ' cycle ' || s.seqcycle::text,
		'sequence', coalesce(t.relname, c.relname)
	from pg_sequence s join pg_class c on c.oid = s.seqrelid join pg_namespace n on n.oid = c.relnamespace
	left join pg_depend d on d.classid = 'pg_class'::regclass and d.objid = c.oid
		and d.refclassid = 'pg_class'::regclass and d.refobjsubid > 0 and d.deptype in ('i', 'a')
	left join pg_class t on t.oid = d.refobjid
	left join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
	where n.nspname = current_schema() and coalesce(t.relname, c.relname) <> 'store_migration'
	and not exists (select 1 from pg_depend x where x.classid = 'pg_class'::regclass and x.objid in (c.oid, t.oid) and x.deptype = 'e')
order by 1`;
