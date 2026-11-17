---
id: mem-HCTy4jMc
title: OpenCode 插件推广：无官方插件目录，靠 npm keyword opencode-plugin + awesome-opencode YAML PR + opencode.im 自动索引
tags:
  - opencode
  - promotion
  - ecosystem
  - distribution
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-17T14:32:03.633Z
---
OpenCode（opencode.ai）没有官方插件目录/注册表：/plugins 与 /ecosystem 均 404，官方仓库 opencode README 也未背书任何 awesome 列表，GitHub Discussions 已关闭。因此“上架”只能走三类渠道：

1) 零审核的自动发现面（最优先）：npm 包带 keywords ["opencode-plugin"] + README 写明 OpenCode 安装示例；GitHub 仓库打 topic "opencode-plugin"。opencode.im 每日扫描 npm keyword 自动收录，但发布前人工审核。
2) awesome-opencode/awesome-opencode（事实上的权威列表，非官方）：只能提 PR 新增 data/plugins/<kebab-case>.yaml，禁止改 README（README 由 YAML 生成）；需真实 OpenCode 目标、自带 OpenCode 配置文档、公开可跑、90 天内有提交、未归档、有最低 star 与仓库年龄门槛；描述里必须声明支持 OpenCode V1 还是 V2（两者插件 API 不通用），可选 min_version。门槛具体数值易变，提交前读 contributing.md。
3) opencode.im 的 submit 表单（可为 GitHub-only 插件提交）+ opencode.cafe（第三方、活跃度低）。opencode.asia/ecosystem/awesome 只是多语言镜像，无需单独投。

判断依据：docs/plugins 只讲 `plugins` 配置与 `opencode plugin add`（支持 npm 名/版本范围/git 规格），没有任何“提交到目录”的入口。官方社区仅 Discord + X。
