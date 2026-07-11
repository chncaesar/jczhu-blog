---
title: 我给 OpenCode 写了个小插件，只为让 AI 别再手搓 sleep loop
description: AI coding 里最烦的不是大 bug，而是那些每天重复几十次的小摩擦。我翻了本地 OpenCode 记录，发现等待服务、健康检查、部署验证这类轮询动作反复出现，于是把它们收敛成了一个 wait_for 工具。
date: 2026-07-10
---

最近写了个很小的 OpenCode 插件，叫 `opencode-waitfor`。

小到什么程度？它只做一件事：等。

等一个本地 dev server 起好，等一个端口打开，等 Docker 容器变 healthy，等部署后的 `/health` 返回新版本号。以前这些事，我都是让 Agent 自己写 shell：`sleep` 一下，`curl` 一下，失败了再来一遍。能用。但用多了以后，我越来越烦。

---

## 日常循环

场景很普通。让 Agent 改完一个服务，启动本地预览。它跑了命令，然后想确认服务起来没有。于是它写：

```bash
for i in $(seq 1 40); do
  curl -f http://localhost:3000/health && break
  sleep 3
done
```

部署后验证也一样。先 `curl /health`，看状态是不是 ok，再看返回里的 version 是不是刚推上去的 commit。Docker 容器也是一样。`docker inspect`，看 health status，不是 healthy 就 sleep，再查一次。这些脚本本身没什么错。老工程师也会这么写。

问题是 Agent 每次都重新写一遍。今天写成 `seq 1 30`，明天写成 `while true`，后天忘了 timeout。一次 probe 失败，它再补一条命令。又失败，它再看日志。对话里开始堆满这种东西：`sleep`、`curl`、`grep`、半截 JSON、半截 stderr。你本来只是想知道一件事：服务好了没有。结果对话变成了：服务可能好了，也可能没好，我们先等三秒看看。

---

## 这不是一个脚本问题

手写轮询最烦的地方，不是它丑。是它把一个明确的动作拆成了很多轮对话。Agent 发一个命令，等一下，读输出，再决定下一步。中间任何一步都可能跑偏：输出太长，重点被淹掉；状态还没变，它急着下结论；循环没写好，失败时看不到最后一次到底返回了什么。人也会被拖进去。你看着终端里一行一行刷新，心里知道它只是还没 ready，但聊天上下文里已经多了十几条没营养的记录。

AI coding 里这种摩擦很隐蔽。它不是大 bug，不会让你拍桌子。它只是每天出现几十次，每次吃掉一点注意力。等你反应过来的时候，一场 session 已经被这些等待、探测、重试塞满了。我后来翻了一下自己的 OpenCode 记录，发现这不是感觉。139 个 session 里，手写 `sleep` loop 出现了 215 次。HTTP `/health` 探测 82 次。Docker health 检查 44 次。部署后拿 `/health` 里的 version 或 SHA 做匹配，9 次。TCP 端口检查，4 次。

数字不大，但形状很清楚：这是一个稳定重复的动作。稳定重复，就不该继续靠 Agent 临场发挥。

---

## 于是我把它做成了工具

`opencode-waitfor` 只注册一个工具：`wait_for`。

给它一个 target，它自己判断该怎么等：

| target 长什么样 | 怎么等 |
| --- | --- |
| `http://localhost:3000` | HTTP |
| `localhost:5432` | TCP |
| 其他字符串 | shell command |

然后它阻塞到两种结果之一：ready，或者 timeout。这件事听起来太小了，甚至不像一个插件。但我想要的正是这种小。Agent 不需要再现场发明一个循环，不需要决定 sleep 几秒，不需要在失败后再补一次探测。它只需要表达意图：等这个东西准备好。
比如等本地服务：

```text
wait_for http://localhost:3000
```

等数据库端口：

```text
wait_for localhost:5432
  timeout 10
```

等 Docker 容器健康：

```text
wait_for 'docker inspect -f "{{.State.Health.Status}}" pg | grep -q healthy'
  timeout 60 interval 5
```

部署后确认版本：

```text
wait_for http://host/api/health
  timeout 30 interval 3
  expect { json_match: { status: ok, version: abc123 } }
```

成功了，返回成功。超时了，也不直接把问题丢掉，而是带回最后一次看到的状态：最后的 HTTP status、body，或者最后一次命令的 exit code、stdout、stderr。这样 Agent 能接着判断为什么没 ready，而不是又手写一轮 `curl`。

---

## 这不是为了少打几行 shell

如果只是少写几行脚本，这个插件没什么意思。真正的变化是边界变了。以前等待服务这件事，是 Agent 自己临时写代码。每次都要重新做几个决定：等什么，怎么判断成功，多久超时，失败时留下什么诊断。这些决定看起来简单，但简单不代表应该重复。

现在它变成了一个工具调用。Agent 不再负责实现等待逻辑，只负责说清楚要等的对象和成功条件。这跟我最近对 AI coding 的判断是一致的：不要把所有协作规则都塞进 prompt。反复出现的动作，要从聊天里拿出来，沉淀成工具、测试、脚本、检查项。Prompt 是软的，会漏。工具是硬的，每次都按同一套规则执行。

`wait_for` 做的事很窄，但它把一类小摩擦从对话里删掉了。

所以我也没有把它当成一段随手脚本来写。类型判断、dot-path 匹配、HTTP/TCP/命令三种 probe、timeout 边界、失败时最后状态的保留，都补了测试。原因很简单：这个工具本身就是为了少让 Agent 临场发挥。如果工具内部也靠感觉，那只是把不确定性换了个地方藏起来。

---

## 怎么装

在 `opencode.json` 里加插件：

```json
{
  "plugin": ["opencode-waitfor"]
}
```

然后重启 OpenCode。它没有复杂配置。HTTP target 必须带 `http://` 或 `https://`，否则会被当成命令。`json_match` 只做字符串匹配，不做正则，也不做深度比较。命令模式会走 shell，安全性自己负责。这些限制我都故意留在 v1 里。插件越小，Agent 越不容易误用。

---

## 小摩擦不是小事

AI coding 里大家爱讨论大问题：架构判断、代码审查、测试覆盖、幻觉、上下文窗口。这些都重要。

但真正每天磨人的，常常是很小的东西。等服务启动，等容器健康，等部署生效，等一个端口打开。它们每个单独看都不值得写文章，合起来却在不断消耗对话质量。

一个工具解决不了 AI coding 的所有问题。`opencode-waitfor` 更解决不了。

但它消灭了一种我每天都会遇到的小摩擦。Agent 不用再手搓 sleep loop，我也不用再看它手搓 sleep loop。对我来说，这就够了。

AI workflow 的改进，很多时候不是发明一套宏大的系统。是你发现一个动作出现了第十次，然后停下来，把它变成工具。
