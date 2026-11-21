// Complete SQL schema objects including the multilingual search romanization table (excluded from cell runtime bundles).
import { objectsWithSearch } from './ddl.ts';
import { search_functions } from './search.ts';

/** Complete SQL definitions, including the database's multilingual search functions. */
export const schema_objects = /*#__PURE__*/ objectsWithSearch(search_functions);
