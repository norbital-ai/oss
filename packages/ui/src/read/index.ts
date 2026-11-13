// `@norbital-ai/ui/read`: the read helpers a host or page shares with ui's views. `label_read` reads a record label's
// own-field dependencies; `unref` turns read rows back into foreign-key ids with each target's label in `$refs`.
export { label_read, unref } from '../relations/select.js';
