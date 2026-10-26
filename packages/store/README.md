# `@norbital-ai/store`

The one data layer a Bolt workspace and its host share. A schema is a value; the store turns each read, write
and migration over it into the SQL it runs and the Effect Schema decoder of its rows. It never connects to a
database: the caller executes every statement.

See [the store guide](./docs/README.md).
