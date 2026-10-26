// Immutable v1 SQL: committed snapshots keep their original physical definition.
export const ROW_RULES_V1 = `create or replace function store_row_rules() returns trigger language plpgsql as $store_rules$
declare
	rules jsonb := tg_argv[0]::jsonb;
	context jsonb := nullif(current_setting('store.write', true), '')::jsonb;
	mode text := coalesce(context->>'mode', 'write');
	before_row jsonb;
	after_row jsonb;
	state_name text;
	state_spec jsonb;
	state_rule jsonb;
	field_name text;
	columns jsonb;
	column_name text;
	parent jsonb;
	parent_id jsonb;
	parent_row jsonb;
	trusted boolean;
	at_time timestamptz;
begin
	if mode not in ('write', 'seed', 'restore') or
		(context is not null and jsonb_typeof(context) <> 'object') then
		raise exception 'invalid native write context' using errcode = '22023';
	end if;
	trusted := mode in ('seed', 'restore');
	if tg_op <> 'INSERT' then before_row := to_jsonb(old); end if;
	if tg_op <> 'DELETE' then after_row := to_jsonb(new); end if;
	if tg_op = 'UPDATE' then
		for column_name in select jsonb_array_elements_text(rules->'key') loop
			if before_row->column_name is distinct from after_row->column_name then
				raise exception 'the primary key of % is immutable', tg_table_name
					using errcode = '23514', column = column_name;
			end if;
		end loop;
	end if;
	if not trusted then
		for state_name, state_spec in select key, value from jsonb_each(rules->'states') loop
			if tg_op = 'INSERT' and after_row->>state_name is distinct from state_spec->>'initial' then
				raise exception 'a new % row starts with % = %', tg_table_name, state_name, state_spec->>'initial'
					using errcode = '23514', column = state_name;
			elsif tg_op = 'UPDATE' then
				state_rule := state_spec->'states'->(before_row->>state_name);
				if before_row->state_name is distinct from after_row->state_name and
					not coalesce(state_rule->'to' ? (after_row->>state_name), false) then
					raise exception '% cannot move from % to %', state_name, before_row->>state_name, after_row->>state_name
						using errcode = '23514', column = state_name;
				end if;
				if coalesce(state_rule->>'edit', 'all') <> 'all' then
					for field_name, columns in select key, value from jsonb_each(rules->'fields') loop
						if field_name = state_name or (jsonb_typeof(state_rule->'edit') = 'array' and state_rule->'edit' ? field_name) then continue; end if;
						for column_name in select jsonb_array_elements_text(columns) loop
							if before_row->column_name is distinct from after_row->column_name then
								raise exception '% is locked while % is %', field_name, state_name, before_row->>state_name
									using errcode = '23514', column = field_name;
								end if;
						end loop;
					end loop;
				end if;
			end if;
		end loop;
		for parent in select value from jsonb_array_elements(rules->'parents') loop
			for parent_id in
				select distinct value from jsonb_array_elements(jsonb_build_array(
					before_row->(parent->>'column'), after_row->(parent->>'column')
				)) where value <> 'null'::jsonb order by value
			loop
				execute format('select to_jsonb(p) from %I.%I p where p.%I = $1::%s for share',
					tg_table_schema, parent->>'table', parent->>'key', parent->>'type')
					into parent_row using parent_id #>> '{}';
				if parent_row is null then continue; end if;
				for state_name, state_spec in select key, value from jsonb_each(parent->'states') loop
					state_rule := state_spec->'states'->(parent_row->>state_name);
					if coalesce(state_rule->>'edit', 'all') <> 'all' and
						not coalesce(jsonb_typeof(state_rule->'edit') = 'array' and state_rule->'edit' ? (parent->>'relation'), false) then
						raise exception 'relation % is locked while % is %', parent->>'relation', state_name, parent_row->>state_name
							using errcode = '23514', column = parent->>'column';
					end if;
				end loop;
			end loop;
		end loop;
	end if;
	if coalesce((rules->>'audit')::boolean, false) and tg_op <> 'DELETE' then
		at_time := coalesce((context->>'at')::timestamptz, clock_timestamp());
		if tg_op = 'INSERT' then
			if new.revision < 1 or (not trusted and new.revision <> 1) then
				raise exception 'a new % row starts at revision 1', tg_table_name using errcode = '23514', column = 'revision';
			end if;
			if context is not null then
				new.created_at := at_time;
				new.created_by := context->>'actor';
			end if;
			new.updated_at := new.created_at;
			new.updated_by := new.created_by;
		else
			if new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by then
				raise exception 'creation metadata is immutable' using errcode = '23514', column = 'created_at';
			end if;
			if new.revision is null or new.revision not in (old.revision, old.revision + 1) then
				raise exception 'revision must advance by one' using errcode = '23514', column = 'revision';
			end if;
			if context is not null then new.updated_by := context->>'actor';
			elsif new.revision = old.revision then new.updated_by := null;
			end if;
			new.revision := old.revision + 1;
			new.updated_at := at_time;
		end if;
	end if;
	if tg_op = 'DELETE' then return old; end if;
	return new;
end;
$store_rules$`;

/** V2 adds exact host-admitted anonymisation fields without changing v1 replay bytes. */
export const ROW_RULES_V2 = ROW_RULES_V1.replace(
	'\ttrusted boolean;\n',
	"\ttrusted boolean;\n\tanonymised jsonb := '[]'::jsonb;\n"
).replace(
	`\t\t\t\t\tfor field_name, columns in select key, value from jsonb_each(rules->'fields') loop
\t\t\t\t\t\tif field_name = state_name or (jsonb_typeof(state_rule->'edit') = 'array' and state_rule->'edit' ? field_name) then continue; end if;`,
	`\t\t\t\t\t-- A host may admit exact anonymisation columns through its native operation, never a whole-row bypass.
\t\t\t\t\tif to_regprocedure(format('%I.%I(text,text)', tg_table_schema, 'store_anonymise_fields')) is not null then
\t\t\t\t\t\texecute format('select %I.%I($1,$2)', tg_table_schema, 'store_anonymise_fields')
\t\t\t\t\t\t\tinto anonymised using tg_table_name, after_row->>'id';
\t\t\t\t\tend if;
\t\t\t\t\tfor field_name, columns in select key, value from jsonb_each(rules->'fields') loop
\t\t\t\t\t\tif field_name = state_name or anonymised ? field_name
\t\t\t\t\t\t\tor (jsonb_typeof(state_rule->'edit') = 'array' and state_rule->'edit' ? field_name) then continue; end if;`
);
