---
title: 我给 AI Agent 做了一张数据库地图，但故意没让它执行 SQL
description: db-semantic-mcp 是一个支持 PostgreSQL 和 SQL Server 的只读 MCP 服务。它把表结构、字段注释、受控样例数据和业务语义提供给 AI Agent，同时不开放任意 SQL 执行能力。
date: 2026-08-10
---

现在很多 AI 编程工具都能接数据库。

最直接的做法，是给 Agent 一个 SQL 工具。它想知道什么，就自己写查询、自己执行。

但我一直觉得，这个顺序反了。

Agent 还不知道哪些表是订单，哪些字段代表业务状态，`ods`、`dw`、`staging` 分别装了什么，就先拿到了执行 SQL 的能力。缺少语义层的能力，Agent 就像盲人摸象。

所以我写了一个小工具：[`db-semantic-mcp`](https://github.com/chncaesar/db-semantic-mcp)。

它是一个面向 AI 编程 Agent 的数据库语义 MCP 服务，支持 PostgreSQL 和 SQL Server。它能让 Agent 查看表、字段、注释和少量样例数据，也能用自然语言搜索数据库结构。

但它不提供任意 SQL 执行能力。

这不是少做了一个功能，而是这个项目最重要的边界。

---

## 数据库真正难懂的不是 SQL

演示数据库通常很好懂。客户表叫 `customers`，订单表叫 `orders`，字段名也都是完整英文。Agent 看一眼就知道该去哪儿找数据。

真实数据库很少这么配合。

一个 ERP 或数仓里可能有几千张表。客户主数据也许叫 `t_bd_customer`，销售相关表都以 `t_sal_` 开头，在制品藏在某张名称缩写到几乎看不懂的表里。业务人员说“应收账款”，数据库里却没有任何一张表直接叫这个名字。

表结构是可见的，业务含义却不是。

这时让 Agent 直接写 SQL，它首先要做的不是查询，而是猜：

- “客户”对应哪张表？
- 这个状态字段是审批状态、删除标记，还是单据状态？
- `ods` 里的原始表和 `dw` 里的事实表，应该用哪一个？
- 金额字段存的是元、分，还是带四位精度的定点数？
- 用户说“WIP”或“在制品”，数据库里对应什么命名？

这些问题都发生在 SQL 之前。

`db-semantic-mcp` 解决的就是这一层：先让 Agent 看懂数据库，再决定后面要做什么。

---

## 四个工具

服务一共提供四个 MCP 工具。

### `list_tables`

列出数据库里的表，包括 schema、表名和表注释。可以只看某个 schema，也可以浏览全部非系统 schema。

Agent 不需要让人手工贴一份表名清单，可以先自己发现数据库里有什么。

### `describe_table`

查看一张表的字段名、数据类型、是否允许为空以及字段注释。

找到疑似相关的表以后，Agent 可以继续确认字段含义，而不是只凭表名开始编 SQL。

### `sample_data`

读取少量样例行。

有些字段光看类型和注释仍然不够。比如一个状态字段是 `A`、`B`、`C`，或者一个编码字段实际长什么样，看几行数据通常比继续猜更有效。

样例数据不是纯元数据，它可能包含真实业务内容，所以这个工具有明确的响应边界：默认只返回 5 行，最多 20 行；响应大小默认最多约 50KB；还可以配置字段白名单、黑名单和脱敏规则。像邮箱、手机号、密码、令牌这类字段，可以直接排除或替换成 `[REDACTED]`。

### `search_schema`

用自然语言搜索表和字段。

例如：

```text
search_schema keyword="应收账款"
search_schema keyword="WIP inventory"
search_schema keyword="sales order"
```

它会把数据库结构快照和业务语义文档一起交给一个 OpenAI 兼容的模型，让模型匹配相关表和字段。搜索支持中英文术语、同义词和业务别名。

只有这个工具需要配置 LLM。前面三个工具不依赖 `LLM_API_KEY`。

---

## 用 Markdown 补上业务语义

只读取数据库注释还不够，因为很多数据库的注释本来就不完整。

`db-semantic-mcp` 允许指定一个普通的 `SCHEMA.md`。没有专用 DSL，也不需要部署向量数据库。团队只要把真正影响理解的信息写进去：

```markdown
## 命名约定

- `ods.*` 保存源系统原始数据
- `dw.*` 保存清洗后的事实表和维度表
- `staging.*` 只用于 ETL 中间过程

## 业务术语

| 业务术语 | 对应表 |
| --- | --- |
| 客户 | ods.bd_customer, dw.dim_customer |
| 库存 | dw.fact_inventory_snapshot |
| 在制品 / WIP | dw.fact_wip_by_lot |

## 设计约定

- 金额统一使用整数分
- `_modified_at` 是增量同步水位
- `doc_status = 'D'` 表示软删除
```

`search_schema` 会把这份文档和缓存的数据库结构一起使用。用户说的是业务语言，数据库里存的是物理结构，这个 Markdown 文件负责把两边接起来。

它也很容易维护。可以和项目放在一起，走 Git review，业务含义变了就直接改文档，不需要重新构建索引。

---

## 为什么不让它执行 SQL

因为“理解数据库”和“操作数据库”是两个不同的权限层级。

一旦开放任意 SQL，即使数据库账号只有只读权限，也要继续处理查询成本、行级权限、敏感数据外泄、审计以及数据内容中的提示注入。不是不能做，而是安全问题会立刻扩大很多。

`db-semantic-mcp` 选择停在更窄的位置：

- 可以发现表和字段；
- 可以读取数据库注释；
- 可以在限制、过滤和脱敏后查看少量样例；
- 可以根据业务语言搜索结构；
- 不能接收并执行 Agent 随意生成的 SQL。

它不是 text-to-SQL，也不是数据库管理工具。它是 text-to-SQL 之前的那一层。

如果后续任务确实需要查询，可以再给 Agent 配一个权限受控、审计完整的查询工具。但在那之前，它至少已经知道数据库里有什么，不必一边猜表名，一边执行查询。

---

## PostgreSQL 和 SQL Server 用同一套接口

项目会根据 `DATABASE_URL` 自动选择后端：

```text
postgresql://user:pass@localhost:5432/mydb
sqlserver://user:pass@host:1433?database=mydb&encrypt=disable
```

PostgreSQL 使用 `asyncpg`，SQL Server 使用 `pymssql`。上层四个 MCP 工具保持不变。

对于表特别多的数据库，可以用 `CACHE_SCHEMAS` 限定 schema，也可以用 `CACHE_TABLE_PREFIX` 只缓存指定前缀的表。比如只把 `t_pur_`、`t_sal_`、`t_stk_`、`t_bd_` 这些业务表放进语义搜索上下文，避免几千张无关表一起消耗模型上下文。

这些过滤只影响语义搜索缓存，不影响直接调用 `list_tables`、`describe_table` 和 `sample_data`。

---

## 安装和配置

PostgreSQL 版本直接安装：

```bash
pip install db-semantic-mcp
```

需要 SQL Server 支持：

```bash
pip install "db-semantic-mcp[sqlserver]"
```

要求 Python 3.11 以上。

最小配置只需要数据库连接：

```bash
export DATABASE_URL="postgresql://user:pass@localhost:5432/mydb"
pg-semantic-mcp
```

如果要用语义搜索，再增加：

```bash
export SEMANTIC_FILE="/path/to/SCHEMA.md"
export LLM_API_KEY="sk-..."
export LLM_MODEL="gpt-4o-mini"
```

也可以通过 `LLM_BASE_URL` 接 DeepSeek、Ollama、LM Studio 或其他 OpenAI 兼容接口。

在 OpenCode 中可以这样注册：

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

项目名已经是 `db-semantic-mcp`，命令暂时仍叫 `pg-semantic-mcp`，这是为了兼容最初只支持 PostgreSQL 时的入口。

Claude Code、Cursor 以及其他支持 MCP 的客户端，也可以用同样的服务。

---

## 先理解，再执行

我做 `db-semantic-mcp`，不是为了让 Agent 对数据库拥有更多权力，而是为了减少它在行动之前的猜测。

数据库里最难传递的，往往不是字段类型，而是业务语义：哪些表真正重要，缩写代表什么，同一个概念在代码、业务和数据库里分别叫什么，哪些数据能看，哪些字段必须隐藏。

把这些信息稳定地提供给 Agent，它才能在修改后端、排查数据映射或维护 ETL 时，先找到正确的位置。

项目地址：[`github.com/chncaesar/db-semantic-mcp`](https://github.com/chncaesar/db-semantic-mcp)
