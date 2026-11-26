// `@norbital-ai/bolt/protocol`: the wire and artifact types — a host or a client written
// outside Bolt names its bodies with these. TemplateManifest decodes norbital.template.json for the catalogue,
// host picker and website. The paths and handlers stay internal.
export { TemplateCapability, TemplateManifest } from './schema.ts';
