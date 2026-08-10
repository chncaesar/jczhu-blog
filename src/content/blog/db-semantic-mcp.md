---
title: db-semantic-mcp Gives AI Agents a Safe Semantic Map of Your Database
description: A lightweight MCP server that exposes PostgreSQL and SQL Server schema metadata, comments, sample rows, and semantic search to AI coding agents without giving them a SQL execution surface.
pubDate: 2026-08-10
tags:
  - ai-coding
  - mcp
  - database
  - agent-workflow
---

AI agents are getting database access before they understand databases.

That is the wrong order.

A real production database is rarely self-explanatory. The important table is not always named `orders`. The customer table may be called `t_bd_customer`. A field may carry a business-critical status code that only makes sense if you know the system behind it. A warehouse may split raw operational data, cleaned dimensions, and aggregated facts across schemas with names like `ods`, `dw`, and `staging`. The schema is technically visible, but the meaning is not.

So I built [`db-semantic-mcp`](https://github.com/chncaesar/db-semantic-mcp): a small MCP server that gives AI coding agents a safe semantic map of a database.

It exposes table names, column types, comments, sample rows, and LLM-powered schema search. It supports PostgreSQL and SQL Server. It works with MCP-compatible agent clients such as OpenCode, Claude Code, Cursor, and similar tools.

It deliberately does not execute SQL.

That boundary is the point.

---

## The missing layer between agents and databases

Most database integrations for agents start with query execution. Give the model a connection string, add a SQL tool, maybe add a read-only role, and let it ask the database questions.

That can be useful. It is also a big first step.

Before an agent writes or runs a query, it needs to answer more basic questions:

- Which tables are relevant?
- What do these column names mean?
- Which schema contains source data and which contains modeled data?
- Is this field a business status, a foreign key, a soft-delete marker, or an internal implementation detail?
- When a user says "inventory", "receivables", "customer", or "WIP", what tables should the agent inspect?

Those are not SQL execution questions. They are database understanding questions.

`db-semantic-mcp` focuses on that layer. It gives the agent enough structure to navigate the database without turning the database into a remote-control surface.

---

## What it exposes

The server provides four MCP tools:

| Tool | Purpose |
| --- | --- |
| `list_tables` | List database tables with schema names and table comments. |
| `describe_table` | Inspect columns, types, nullability, and column comments. |
| `sample_data` | Fetch a small number of example rows from a table. |
| `search_schema` | Search tables and columns semantically using an OpenAI-compatible LLM. |

The first three tools are direct metadata and sampling operations. They let an agent inspect the database the way a developer would: list tables, open one table, look at columns, check a few rows.

The fourth tool is where the semantic layer matters.

`search_schema` combines a cached schema snapshot with an optional Markdown file that describes your business terms, naming conventions, and database design decisions. The model can then resolve natural-language requests such as:

```text
customer receivables
WIP inventory
sales order
应收账款
```

into the tables and columns that are likely to matter.

This is especially useful for databases where the table names are technically consistent but not obvious to an agent. ERP databases, legacy SQL Server systems, and large warehouse schemas often fall into that category.

---

## The semantic file is intentionally boring

There is no new ontology format to learn. There is no vector database to deploy. There is no separate catalog service.

You write a Markdown file.

For example:

```markdown
# Database Semantic Context

## Naming Conventions

- `ods.*` tables contain raw operational data.
- `dw.*` tables contain modeled fact and dimension tables.
- `staging.*` tables are temporary ETL staging tables.

## Business Terms

| Business term | Table(s) |
| --- | --- |
| Customer | ods.bd_customer, dw.dim_customer |
| Inventory | dw.fact_inventory_snapshot |
| WIP / work in progress | dw.fact_wip_by_lot |

## Design Decisions

- Monetary amounts are stored in integer cents.
- `_modified_at` columns are incremental sync watermarks.
- Soft deletes use `doc_status = 'D'`.
```

That file is loaded into the schema search prompt. It is the bridge between the database's physical structure and the vocabulary developers or business users actually use.

The important design choice is that the semantic layer stays close to the team. It can live next to the project. It can be reviewed like documentation. It can be changed without re-indexing a vector store or migrating a metadata system.

---

## Why no SQL execution?

Because the first safe primitive an agent needs is not always a query tool.

If an agent can execute arbitrary SQL, even read-only SQL, the safety problem becomes larger immediately. You need to think about permissions, row-level access, query cost, data exfiltration, audit logs, and prompt injection through data. Those problems are solvable, but they are not free.

`db-semantic-mcp` takes a narrower position: give the agent visibility into structure and meaning first.

That makes the tool useful in more conservative environments. A team may be comfortable exposing table metadata, comments, and a few sample rows to an agent long before it is comfortable giving the agent a general SQL execution surface. The server still connects to the database, so it should be configured carefully, but its product boundary is intentionally smaller.

The result is not a text-to-SQL platform. It is the layer before text-to-SQL. It helps the agent understand where it is.

---

## Built for real databases, not demo schemas

The first implementation supported PostgreSQL. The current version also supports SQL Server through the same MCP interface.

The backend is selected from the `DATABASE_URL` scheme:

```text
postgresql://user:pass@localhost:5432/mydb
sqlserver://user:pass@host:1433?database=mydb&encrypt=disable
```

That matters because a lot of valuable business data is not sitting in a neat Postgres app database. It is in SQL Server. It is in ERP systems. It is in databases with thousands of tables, inconsistent comments, historical naming conventions, and schemas that only a few people inside the company understand.

For those databases, `db-semantic-mcp` includes cache controls such as schema filters and table-prefix filters. If a SQL Server database contains thousands of tables but the useful business tables share prefixes like `t_pur_`, `t_sal_`, `t_stk_`, or `t_bd_`, the schema cache can focus on those areas.

This is not about making a toy database easier to query. It is about making messy real databases navigable by an agent without pretending they are clean.

---

## How an agent uses it

Once registered with an MCP client, the workflow is simple.

An agent can start broad:

```text
list_tables schema=dw
```

Then inspect a candidate table:

```text
describe_table table=dw.fact_inventory_snapshot
```

Then look at a few rows:

```text
sample_data table=dw.fact_inventory_snapshot limit=3
```

Or search semantically:

```text
search_schema keyword="customer receivables"
search_schema keyword="应收账款"
```

The agent does not need to guess table names from memory. It does not need the user to paste schema dumps into every prompt. It can ask the database metadata server for the relevant context, then use that context in the coding task.

For example, if the task is to modify an ETL pipeline, add a reporting endpoint, or debug a data mapping issue, the agent can first discover the database shape instead of hallucinating it.

That is the value: better grounding before action.

---

## Configuration shape

The server is configured through environment variables:

```text
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb
SEMANTIC_FILE=/path/to/SCHEMA.md
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
```

`LLM_API_KEY` is only required for semantic search. The metadata tools work without it.

An MCP client can register it as a local server:

```json
{
  "mcp": {
    "db-semantic": {
      "type": "local",
      "command": "pg-semantic-mcp",
      "environment": {
        "DATABASE_URL": "postgresql://user:pass@host:5432/dbname",
        "SEMANTIC_FILE": "/path/to/SCHEMA.md",
        "LLM_API_KEY": "sk-..."
      }
    }
  }
}
```

The command name still uses `pg-semantic-mcp` for compatibility with the original PostgreSQL-only version. The package and repository now use the broader `db-semantic-mcp` name because the server supports multiple backends.

---

## What this is good for

`db-semantic-mcp` is useful when an agent needs database context but should not start by executing SQL.

Good fits include:

- AI coding agents working on backend services connected to PostgreSQL or SQL Server.
- Data platform projects where table names and business concepts are not obvious.
- ERP and legacy database exploration, especially when schemas are large.
- Teams that want agent-assisted development without immediately exposing query execution.
- Projects where a lightweight Markdown semantic layer is easier to maintain than a full data catalog.

It is not trying to replace a BI platform, a warehouse catalog, a governance product, or a complete text-to-SQL system.

It is a small missing primitive: let the agent understand the database before it acts on the database.

---

## The broader direction

I think agent tooling is going to split into two categories.

Some tools will make agents more powerful. They will let agents execute, mutate, deploy, administer, and automate more of the system.

Other tools will make agents better grounded. They will expose state, constraints, readiness, history, metadata, and semantics in ways that reduce guessing.

`db-semantic-mcp` belongs to the second category.

It does not make the agent omnipotent. It gives the agent a map. In real engineering work, that is often the safer and more useful first step.

Project: [`github.com/chncaesar/db-semantic-mcp`](https://github.com/chncaesar/db-semantic-mcp)
