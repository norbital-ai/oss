// The persisted JSON structure follows std's kind codecs; file bytes and reference visibility belong to the host.
export const JSON_VALID = `create or replace function store_json_valid(value jsonb, spec jsonb) returns boolean
language plpgsql immutable parallel safe set timezone = 'UTC' set datestyle = 'ISO,YMD' as $store_json$
declare
	kind text := spec->>'kind';
	shape text := jsonb_typeof(value);
	item jsonb;
	field_name text;
	field_spec jsonb;
	text_value text;
	numeric_value numeric;
	float_value double precision;
	length_value bigint;
	year_value int;
	month_value int;
	day_value int;
	days int[];
	from_value text;
	to_value text;
begin
	if value is null then return false; end if;
	if value = 'null'::jsonb and coalesce((spec->>'optional')::boolean, false) then return true; end if;
	if coalesce((spec->>'many')::boolean, false) or coalesce((spec->>'multiple')::boolean, false) then
		if shape <> 'array' then return false; end if;
		for item in select v from jsonb_array_elements(value) items(v) loop
			if not store_json_valid(item, spec - array['many','multiple','optional']) then return false; end if;
		end loop;
		return true;
	end if;
	case kind
	when 'json' then
		return case when spec ? 'shape' then store_json_valid(value, spec->'shape') else true end;
	when 'custom' then return true;
	when 'list', 'vector' then
		if shape <> 'array' then return false; end if;
		length_value := jsonb_array_length(value);
		if kind = 'vector' and length_value <> (spec->>'dim')::numeric then return false; end if;
		if kind = 'list' and ((spec ? 'min' and length_value < (spec->>'min')::numeric) or
			(spec ? 'max' and length_value > (spec->>'max')::numeric)) then return false; end if;
		for item in select v from jsonb_array_elements(value) items(v) loop
			if not store_json_valid(item, case when kind = 'vector' then '{"kind":"number"}'::jsonb else spec->'of' end) then return false; end if;
		end loop;
		return true;
	when 'object' then
		if shape <> 'object' then return false; end if;
		for field_name, field_spec in select key, v from jsonb_each(spec->'fields') fields(key,v) loop
			if not (value ? field_name) then
				if coalesce((field_spec->>'optional')::boolean, false) or field_spec ? 'default' then continue; end if;
				return false;
			end if;
			if value->field_name = 'null'::jsonb then
				if coalesce((field_spec->>'optional')::boolean, false) or field_spec ? 'default' then continue; end if;
				return false;
			end if;
			if not store_json_valid(value->field_name, field_spec) then return false; end if;
		end loop;
		if spec ? 'rest' then
			for field_name, item in select key, v from jsonb_each(value) fields(key,v) loop
				if not (spec->'fields' ? field_name) and not store_json_valid(item, spec->'rest') then return false; end if;
			end loop;
		elsif spec->'fields' = '{}'::jsonb and not coalesce((spec->>'tagged')::boolean, false) then
			return value = '{}'::jsonb;
		end if;
		return true;
	when 'union' then
		if spec ? 'arms' then
			if shape <> 'object' or jsonb_typeof(value->(spec->>'by')) is distinct from 'string' then return false; end if;
			text_value := value->>(spec->>'by');
			if not (spec->'arms' ? text_value) then return false; end if;
			return store_json_valid(value, jsonb_build_object('kind','object','fields',(spec->'arms'->text_value) - (spec->>'by'),'tagged',true));
		end if;
		for item in select v from jsonb_array_elements(spec->'of') items(v) loop
			if store_json_valid(value, item) then return true; end if;
		end loop;
		return false;
	when 'record' then
		if shape <> 'object' then return false; end if;
		for item in select v from jsonb_each(value) fields(key,v) loop
			if not store_json_valid(item, spec->'of') then return false; end if;
		end loop;
		return true;
	when 'file' then
		if shape <> 'object' then return false; end if;
		foreach field_name in array array['id','name','mime'] loop
			if jsonb_typeof(value->field_name) is distinct from 'string' then return false; end if;
		end loop;
		return not (value ? 'size') or store_json_valid(value->'size','{"kind":"int"}'::jsonb);
	when 'point' then
		return shape = 'object' and store_json_valid(value->'lat','{"kind":"number"}'::jsonb)
			and store_json_valid(value->'lng','{"kind":"number"}'::jsonb);
	when 'ref' then
		if jsonb_typeof(spec->'to') = 'string' then return shape = 'string'; end if;
		return coalesce(shape = 'object' and jsonb_typeof(value->'collection') = 'string'
			and spec->'to' ? (value->>'collection') and jsonb_typeof(value->'id') = 'string',false);
	when 'period' then
		if shape <> 'object' then return false; end if;
		field_name := case when spec->>'of' = 'date' then 'from' else 'start' end;
		text_value := case when spec->>'of' = 'date' then 'to' else 'end' end;
		field_spec := jsonb_build_object('kind', spec->>'of');
		if not store_json_valid(value->field_name, field_spec) then return false; end if;
		if not (value ? text_value) or value->text_value = 'null'::jsonb then return true; end if;
		if not store_json_valid(value->text_value, field_spec) then return false; end if;
		from_value := value->>field_name; to_value := value->>text_value;
		return case when spec->>'of' = 'date' then from_value <= to_value
			else from_value::timestamptz < to_value::timestamptz end;
	when 'bool' then return shape = 'boolean';
	when 'int', 'number', 'count', 'duration' then
		if shape <> 'number' then return false; end if;
		text_value := value #>> '{}';
		float_value := text_value::double precision;
		if float_value in ('NaN'::double precision,'Infinity'::double precision,'-Infinity'::double precision) then return false; end if;
		numeric_value := text_value::numeric;
		if kind <> 'number' and trunc(numeric_value) <> numeric_value then return false; end if;
		if kind <> 'number' and abs(numeric_value) > 9007199254740991 then return false; end if;
		if kind = 'count' and numeric_value < 0 then return false; end if;
		return (not (spec ? 'min') or numeric_value >= (spec->>'min')::numeric)
			and (not (spec ? 'max') or numeric_value <= (spec->>'max')::numeric);
	when 'decimal', 'money', 'sum' then
		if shape = 'number' then
			float_value := (value #>> '{}')::double precision;
			return float_value not in ('NaN'::double precision,'Infinity'::double precision,'-Infinity'::double precision);
		end if;
		text_value := case when shape = 'object' and jsonb_typeof(value->'$dec') = 'string' then value->>'$dec'
			when shape = 'string' then value #>> '{}' else null end;
		return coalesce(text_value ~ '^-?[0-9]+(\\.[0-9]+)?$',false);
	when 'seq' then
		return case when spec ? 'pattern' then shape = 'string' else store_json_valid(value,'{"kind":"int"}'::jsonb) end;
	when 'text', 'currency', 'id', 'enum', 'state', 'date', 'instant', 'time' then
		if shape <> 'string' then return false; end if;
		text_value := value #>> '{}';
		case kind
		when 'text' then
			if spec ? 'max' then
				select coalesce(sum(case when ch='' then 0 when ascii(ch)>65535 then 2 else 1 end),0) into length_value
					from regexp_split_to_table(text_value,'') chars(ch);
				if length_value > (spec->>'max')::numeric then return false; end if;
			end if;
			return spec->>'format' is distinct from 'email' or text_value ~ '^[^@\\s]+@[^@\\s]+$';
		when 'currency' then return true;
		when 'id' then return text_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
		when 'enum' then return spec->'values' ? text_value;
		when 'state' then return spec->'states' ? text_value;
		when 'time' then return text_value ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]+)?)?$';
		when 'date' then
			if text_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
			year_value := substring(text_value,1,4)::int; month_value := substring(text_value,6,2)::int; day_value := substring(text_value,9,2)::int;
			days := array[31,case when year_value%400=0 or (year_value%4=0 and year_value%100<>0) then 29 else 28 end,31,30,31,30,31,31,30,31,30,31];
			return month_value between 1 and 12 and day_value between 1 and days[month_value];
		when 'instant' then
			if text_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' then
				return store_json_valid(to_jsonb(substring(text_value,1,10)), '{"kind":"date"}'::jsonb)
					and store_json_valid(to_jsonb(substring(text_value,12,12)), '{"kind":"time"}'::jsonb);
			end if;
			return text_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)?)?$'
				and isfinite(text_value::timestamptz);
		else return false;
		end case;
	else return false;
	end case;
exception when data_exception then return false;
end;
$store_json$`;
