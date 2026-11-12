// `@norbital-ai/bolt/protocol` (Appendix D): the C8 wire and C9 artifact types — a host or a client written
// outside Bolt names its bodies with these. TemplateManifest decodes norbital.template.json for the catalogue,
// host picker and website. The paths and handlers stay internal.
export { TemplateManifest } from './schema.ts';
export { uuidv7 } from './wire.ts';
export { ReadRequestJson, dynamic_read, type DynamicRead } from './read-request.ts';
export { MIME, client_page } from './static.ts';
