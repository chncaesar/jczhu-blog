---
title: 我给 OpenCode 写了个数据库清理工具，因为 1GB 里一半都是空气
description: OpenCode 的本地 SQLite 数据库会随着长 session 和 compaction 逐渐膨胀。问题不只是文件大，而是 freelist、WAL、VACUUM 和 auto_vacuum 这些 SQLite 细节叠在一起，决定了你能不能安全地把空间拿回来。
date: 2026-07-22
---

最近我给 OpenCode 写了个很小的工具，叫 `ocdbc`。

全名是 OpenCode Database Cleaner。听起来像那种“清理垃圾文件”的小脚本，但我一开始并不是想写一个清理工具。我只是发现自己的 `opencode.db` 越来越大。

OpenCode 会把 session 历史存在本地 SQLite 数据库里，默认路径是 `~/.local/share/opencode/opencode.db`。长时间用下来，这个文件长到 1GB 甚至 2GB 并不奇怪。直觉上你会以为，数据库大，是因为聊天记录多、工具输出多、session 太长。这个判断只对了一半。

数据库文件 1.3GB，数据只有 525MB，freelist 有 766MB。也就是说，文件一半以上都是无效的。

---

## SQLite 不会主动把空气吐出来

SQLite 的数据库文件由一页一页的 page 组成。表、索引、记录，最后都落在这些 page 里。删除数据以后，SQLite 不一定会把文件截短。它更常见的做法是把不用的 page 放进 freelist，留给以后复用。

这很合理。数据库今天删掉一些记录，明天可能又写进来一些记录。与其频繁改文件大小，不如把空页留在文件里面，下次直接用。对很多应用来说，这是性能和实现复杂度之间很实际的取舍。

问题是，文件系统不认识 SQLite 的 freelist。它只看到一个 1.3GB 的文件。里面 766MB 是可复用空页，还是有效业务数据，磁盘都照样占着。

所以你会看到一种很反直觉的情况：OpenCode 做过 session compaction，旧上下文被摘要了；你也许还删过一些历史数据；数据库内部确实少了很多活数据。但 `opencode.db` 在磁盘上还是那么大。不是数据没删掉，而是 SQLite 把删出来的空间留在了文件里。

这就是 `freelist_count` 的意义。

`ocdbc analyze` 做的第一件事，就是把这件事说清楚。它读 `PRAGMA page_size`、`PRAGMA page_count`、`PRAGMA freelist_count`，算出活数据和空闲页各占多少。这个命令是只读的，不改数据库，只回答一个问题：这个文件到底是实心的，还是里面已经空了一大块。

---

## VACUUM 不是删除数据，是重建文件

要把 freelist 里的空间还给文件系统，SQLite 的传统办法是 `VACUUM`。

很多人看到 `VACUUM` 会下意识紧张，好像它在删东西。其实它做的事更接近“搬家”。SQLite 重新创建一个干净的数据库文件，把仍然有效的数据和索引按当前状态写进去，然后用新的文件替换旧文件。freelist 里的空页不会被搬过去，文件自然就瘦下来了。

这也是为什么 `VACUUM` 能把 1.3GB 变成 500 多 MB。它不是理解了 OpenCode 的业务，也不是知道哪些 session 重要。它只是站在 SQLite 的层面，把数据重新排了一遍。

但正因为 `VACUUM` 是重建文件，它就不是一个可以随手敲的命令。

如果 OpenCode 还开着，数据库还在写，执行 `VACUUM`，最轻也是冲突，严重一点就是把自己放进一个很难判断的状态。SQLite 本身有锁机制，但本地工具不该把安全边界全推给数据库。`ocdbc vacuum` 第一件事就是用 `fuser` 看有没有进程还打开着这个数据库。有人用着，就拒绝运行。这很重要。

---

## WAL 让备份变得没那么直观

SQLite 还有一个容易被忽略的细节：WAL。

OpenCode 的数据库通常跑在 WAL 模式下，也就是 write-ahead log。写入时，SQLite 可以先把变更追加到 `opencode.db-wal`，不一定立刻合并回主数据库文件 `opencode.db`。这样读写并发更好，性能也更稳。但 WAL 会让“我复制了一个 `.db` 文件，所以我有备份”这句话变得不够严谨。如果还有已经提交但尚未 checkpoint 回主库的内容，只复制 `opencode.db`，可能拿到的不是完整状态。真正完整的数据库状态，可能分散在主库和 WAL 文件里。对 SQLite 熟的人知道这点，对一个临时写出来的清理脚本来说，这就是事故入口。所以 `ocdbc` 的顺序是：先 checkpoint WAL，再做完整性检查，再备份主库。

它执行的是 `PRAGMA wal_checkpoint(TRUNCATE)`。这一步把 WAL 里的已提交变更刷回主数据库，并把 WAL 截断。做完以后，再复制 `opencode.db`，这个备份才是完整的。备份创建完还不算结束，工具会再打开备份跑一次 `PRAGMA integrity_check`。备份本身过不了完整性检查，就不能继续。先备份再 checkpoint，看起来也像备份了，其实可能备份的是旧状态。先 `VACUUM` 再检查，失败时你才发现没有可靠回退。数据库维护最怕这种“每一步都像对的，连起来是错的”。

---

## auto_vacuum 解决的是下一次膨胀

跑一次 `VACUUM` 可以把当前的空气挤掉，但它不保证以后不再膨胀。SQLite 有个 `auto_vacuum` 设置。默认的 `NONE` 模式下，释放出来的 page 会进入 freelist，但数据库文件不会自动缩小。`FULL` 会在事务提交时尝试移动 page 并截短文件，代价是可能引入额外开销和碎片移动。`INCREMENTAL` 折中一点：SQLite 维护必要的信息，让后续可以通过 incremental vacuum 逐步回收文件尾部的空页。`ocdbc` 选择的是 `auto_vacuum = INCREMENTAL`。

这里还有个容易踩的坑：从 `NONE` 改到 `INCREMENTAL`，不是简单写一个 pragma 就万事大吉。SQLite 需要通过 `VACUUM` 重建数据库，让这个模式真正写进文件结构。所以工具会先设置 `PRAGMA auto_vacuum = INCREMENTAL`，然后执行 `VACUUM`。这次重建既回收当前 freelist，也让数据库以后具备增量回收的基础。它不是魔法。它不会让所有未来空间自动消失，也不替 OpenCode 决定什么时候做 incremental vacuum。但它至少把数据库从“只会越用越胀”的默认状态，改成了一个以后可以更温和维护的状态。

---

## 我不想写一个勇敢的工具

清理本地数据库这种事，最容易写成一个勇敢的工具。勇敢地打开数据库，勇敢地跑 `VACUUM`，勇敢地告诉你节省了多少空间。失败了再说。反正只是本地文件，不是生产库。我不太喜欢这种勇敢。OpenCode 的数据库不是缓存。里面有 session 历史，有你和 Agent 的工作过程，有很多当时没进 git、但之后可能还要回看的上下文。它不是生产数据库，但它已经是工作资产。对这种文件做维护，至少要有几个基本边界。

所以 `ocdbc vacuum` 的流程很啰嗦：

```text
确认 OpenCode 没有打开数据库
checkpoint WAL
检查原库完整性
创建带时间戳的备份
检查备份完整性
设置 auto_vacuum = INCREMENTAL
执行 VACUUM
恢复 journal_mode = WAL
再次检查完整性
报告前后大小和备份路径
```

其中有些步骤看起来保守，甚至有点烦。比如没有 `fuser` 时默认拒绝运行，必须显式加 `--skip-fuser` 才继续。比如默认一定备份，除非你自己加 `--no-backup`。比如 `VACUUM` 以后要重新设置 WAL，因为 SQLite 的 `VACUUM` 过程可能把 journal mode 重置掉。

这些都不是为了显得专业。它们只是把“我手上这个文件很重要”当成前提。

---

## analyze 比 vacuum 更重要

工具最后只有两个命令。

一个是：

```bash
ocdbc analyze
```

另一个是：

```bash
ocdbc vacuum
```

我其实更喜欢第一个。`analyze` 没有风险，因为它只读。它会告诉你数据库文件多大，page size 是多少，journal mode 是不是 WAL，`auto_vacuum` 当前是什么，freelist 占多少，`VACUUM` 大概能拿回多少空间。它还会顺手看几个主要表的行数和数据量，比如 `message`、`part`、`event`，再列出最大的几条 message。

这比直接清理重要。因为很多时候你以为自己遇到的是一个问题，实际不是。如果 freelist 只有 2%，那文件大就是活数据多，`VACUUM` 没多少意义。你要考虑的是历史保留策略，不是文件重建。如果 freelist 超过 50%，那说明大量空间已经空出来，只是还没还给文件系统。这个时候 `VACUUM` 才是对症的。先体检，再动手。听起来像废话，但很多本地工具就是少了这个顺序。

---

## 小工具背后的本地状态

写 `ocdbc` 的时候，我一直在想另一个问题：AI coding 的本地状态正在变重。

以前一个编辑器最重要的本地状态，也许是配置、插件、最近打开的文件。现在不一样了。Agent 的 session 历史、工具调用记录、上下文压缩 checkpoint、项目级规则、模型交互轨迹，这些东西都开始落在本地。它们不一定都该长期保存，但它们也不再只是临时垃圾。

OpenCode 的 compaction 解决的是模型上下文太长的问题，不是磁盘文件太大的问题。它可以让新一轮模型调用从摘要 checkpoint 继续，但旧消息还在 durable history 里。SQLite 删除或整理后的空页，也还可能留在数据库文件里。这几个层次很容易混在一起：模型看到的上下文变短了，不等于数据库文件变小了；数据库内部有空页，不等于文件系统拿回了空间；复制了 `.db`，也不等于你备份了 WAL 模式下的完整状态。

这些都不是 OpenCode 独有的问题。只要 AI 工具开始把越来越多工作流状态放进本地数据库，类似的问题都会出现。数据库维护不一定复杂，但不能靠直觉。

`ocdbc` 做的事很窄。它不删 session，不判断哪些历史该保留，也不替 OpenCode 设计归档策略。它只回答两个问题：这个 SQLite 文件里有多少空气？如果要把空气挤掉，怎样尽量安全地做？

对我来说，这个边界正好。

AI coding 的基础设施不是只有模型、prompt 和工具调用。还有这些不起眼的本地状态文件。它们平时安静地躺在磁盘上，直到某天长到 1GB、2GB，你才发现自己其实一直在依赖它们。既然依赖，就别把它们当垃圾处理。该分析就分析，该备份就备份，该理解 freelist、WAL、VACUUM 和 auto_vacuum，就不要假装一个 `rm` 或一条随手 SQL 能解决所有问题。

项目地址：`https://github.com/chncaesar/opencode-db-clean`

