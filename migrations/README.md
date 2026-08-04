# migrations

`schema.sql` is all `CREATE TABLE IF NOT EXISTS`, so it builds a database from
scratch but is a no-op against a deployed one — it cannot add a column or replace
an index. These files cover that gap. `./scripts/cf.sh schema` applies both;
`./scripts/cf.sh migrate` applies just these.

## How they're tracked

Applied files are recorded in a `schema_migrations(filename, applied_at)` ledger,
checked before each file runs. Nothing is inferred from error text, so a migration
can be any SQL — `ADD COLUMN`, `DROP INDEX`, a backfill, a data repair.

A brand-new database is **baselined, not migrated**: `schema.sql` already creates
the current shape, so every file is marked applied without running. Replaying
history against a fresh database would fail on the first `ALTER TABLE`, because
there is no table to alter yet.

## Rules

- **Migrations run before `schema.sql`, not after.** `schema.sql` indexes columns
  these files add, so applying it first fails with `no such column` on an existing
  database.
- **Keep every added column nullable or defaulted.** Rows that predate a migration
  have to stay valid.
- **Always update `schema.sql` to match**, so a fresh database gets the same shape
  without replaying history. The two must converge: an existing database run
  through the migrations has to end up with exactly the columns and indexes a
  fresh one gets.
- **Never renumber or edit an applied file.** The ledger keys on the filename, so
  an edited file is silently skipped everywhere it already ran. Add a new one.
