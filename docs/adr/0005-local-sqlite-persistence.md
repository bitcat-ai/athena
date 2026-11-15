---
status: proposed
---

# Local SQLite for persistent application records

## Context

Athena persists related records in separate JSON files. A message and its usage settlement cannot share a transaction, whole histories are rewritten for small updates, and referential/deletion rules live in application code. Webpage runtime identities must nevertheless remain temporary: storing an old ref or approval must never restore execution authority.

The application remains a local Electron workbench. A central service, cloud account or shared multi-user database is not part of this request.

## Proposed decision

Use one SQLite database per existing Local profile, owned by a dedicated Node worker. Keep the existing `Agent Workbench` data identity, keychain integration, browser profile and CLI-owned sessions. Use the bundled `node:sqlite` only after checking the shipped Electron runtime; the design probe found Electron 45.1.0 / Node 24.22.1 / SQLite 3.53.4.

Normalize identifiers, ownership, order and fields needed for queries. Preserve variable historical payloads as validated JSON and bounded message images as BLOBs. Store only descriptive records of page interactions, not live frame handles, control leases, pending approvals or executable queues.

Use foreign keys, STRICT tables, short transactions, explicit per-connection settings and a versioned migration ledger. Start with WAL + FULL on local storage and one writer. Treat external PRD/download files as a separate consistency boundary with metadata and verification, not as part of a database transaction.

Migrate from immutable copies of legacy sources to a new candidate database. Preserve IDs, unknown values and independent-record retention; reject ambiguous or corrupt input rather than silently repairing it. Do not dual-write JSON and SQLite after cutover. The application implementation and actual user-data migration require a separate approved change.

## Alternatives and consequences

- **Keep all JSON:** least runtime change, but retains whole-file writes and cross-file consistency gaps. JSON remains useful for source backups and interchange.
- **Server database:** appropriate if a future multi-user service is explicitly chosen; it adds authentication, deployment and network failure domains absent from the current scope.
- **New native SQLite dependency:** may be useful if the bundled API proves unsuitable. It is not the first choice while the installed runtime already provides the needed primitives, and would add packaging/ABI work.

The proposed worker and SQLite module still need packaged-app, shutdown and load verification. Node 24.22.1 marks the SQLite API as Release candidate. Database constraints cannot prove webpage business success, validate external file contents by themselves or encrypt all application data.

Detailed design, migration boundaries and verified design checks are in [数据库设计](../database-design.md), [SQL 草案](../database/schema.sql) and [官方依据](../database/research.md). This ADR is **proposed**, not an assertion that Athena has migrated.
