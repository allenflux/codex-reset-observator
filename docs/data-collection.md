# 持续积累数据与本地神经网络训练

部署由网站和采集器组成，累计数据写入同一个 MySQL 数据库。采集器定时读取第三方站点公开历史，保留变化过程和当时预测，为以后训练与验证提供数据。训练在本机按需运行，不是线上定时任务。

## 启动与检查

根据仓库的 `.env.example` 配置本地、被 Git 忽略的 `.env`，填写 MySQL 连接字段。已有 `.env` 时保留原文件。配置账号需能连接指定数据库，并在其中创建和读写本项目的 `cro_*` 表；程序不会创建数据库，也不会清空已有业务表。

当前 MySQL 的远程连接端口为 `32768`，设置 `MYSQL_PORT=32768`。如果部署日志出现 `Database unavailable` 或 `collection_database_unavailable`，先核对数据库实际对外端口；`.env` 更新后执行 `docker compose up -d --force-recreate web collector` 重新加载配置。

```bash
docker compose up -d --build
docker compose ps
docker compose exec collector observatory collection-status --check-fresh
```

Compose 只启动 `web` 和 `collector`，连接已有 MySQL；不包含 Redis、数据库容器或训练服务。网站在容器内监听 `0.0.0.0:9090`，默认发布到宿主机 `0.0.0.0:9090`，可用 `PORT` 调整宿主机端口。线上访问 [allenflux.tech:9090](http://allenflux.tech:9090/)，也可直接访问 `http://服务器IP:9090/zh`；本机部署访问 [中文页面](http://localhost:9090/zh)。`0.0.0.0` 是监听地址，浏览器使用上述实际访问地址。应用无需绑定域名；`SITE_URL` 留空时自动使用当前请求地址。两个服务使用相同 MySQL 配置。

如设置 `MYSQL_SSL_CA`，本机训练进程需要能读取该证书；Docker 部署还需通过 Compose 覆盖配置，把证书以只读方式挂载到两个容器中对应的路径。

`collector` 启动时采集历史和社交帖子；历史成功后每 `COLLECTION_INTERVAL_SECONDS` 秒继续采集，默认 `3600` 秒。社交默认开启，每 `SOCIAL_COLLECTION_INTERVAL_SECONDS` 秒同步一次（默认 `300`，最低 `60`）；设置 `SOCIAL_COLLECTION_ENABLED=false` 可关闭。两种采集分别记录结果、计算下一次运行时间。只运行网站不会触发采集。需要确认采集器持续运行：MySQL 能保留已有数据，但不能代替停止的采集进程产生新观测。

不使用 Docker 时，可在单独的终端或进程管理器中运行：

```bash
uv sync
uv run --env-file .env observatory collect
```

单次采集与状态检查：

```bash
uv run --env-file .env observatory collect --once
uv run --env-file .env observatory collection-status --check-fresh
```

`sync-history` 与 `collect --once` 同样写数据库，不再覆盖包内 `observatory/data/online_history.json`。状态包含成功／失败采集次数、当前事件数、历史事件版本数、预测数、最近成功时间。`--check-fresh` 在没有成功采集或成功记录过期时返回非零退出码，便于监控；默认每小时采集时，新鲜度窗口为 3 小时。

## 社交数据范围

服务器读取原站公开接口的单条相关帖子，不是直接抓取完整 X 时间线。只同步正文、来源、发布时间、回复／引用上下文和身份匹配的展示译文；忽略上游 LLM 分类及时间推断。本地规则字段不自动确认为重置事件，当前神经网络也不使用帖子文本特征。确定性的未来公告句由本地规则识别，优先展示公告状态，神经网络保留历史参考值。规则升级可重新分类未经人工修改的既有镜像帖；源正文没变时不追加正文版本，也不刷新首次发现时间或有效期。

帖子按 ID 去重，内容变化追加版本；重复读取不刷新信号有效期。空响应或采集失败保留已有记录，人工审核及浏览器来源的同 ID 记录不会被覆盖。状态接口 `GET /api/social/status` 不依赖扩展心跳，并显示覆盖范围、新鲜度、帖子与版本数。`observatory sync-social` 可以单次补采；它不训练模型。

## 保存哪些内容

| MySQL 表 | 用途 |
| --- | --- |
| `cro_collection_runs` | 每次采集的本机观察时间、成功／失败状态、来源元数据和完整历史快照标识 |
| `cro_event_versions` | 事件的不同内容版本、首次观察时间和原始规范化字段 |
| `cro_run_events` | 每次成功采集实际包含的事件版本，保留当时的完整历史集合 |
| `cro_predictions` | 采集器当时独立计算的统计／神经网络概率、特征、模型标识及对应的采集批次 |
| `cro_records` | 网站运行时新增记录，以及 `tibo_signals` 帖子、`social_post_versions` 修订、`social_collection_state` 同步状态；通过记录类型区分 |

这些表采用 `CREATE TABLE IF NOT EXISTS` 增量创建。事件内容不变时复用已有版本；每次成功采集仍保留覆盖证据。来源更正或移除事件时，旧快照仍能还原，最新页面使用最近成功采集的完整集合。失败采集保留失败状态，不当成空历史。

采集器的存档预测使用最新公开历史和项目内置上下文，不合并网站收到的实时 Webhook 或在线状态查询，因此统计基线可能与网页中的统计基线不同；当前主神经网络只依赖历史时间特征。存档时分别记录统计和神经网络结果，不会把主预测冒充统计基线。`forecastContext` 记录这个计算范围；保存的 7 项特征用于神经网络历史特征，并非统计模型的全部输入。

事件的“执行时间”和“首次被我们的采集器发现的时间”是两个字段。第一批导入的历史记录保留为历史补录，不能声称是我们在事件发生时观察到的。后续训练与审计可以按当时已经发现的记录重建特征，避免把晚到的记录或事后更正提前放入旧预测。

网站从 MySQL 读取最新成功快照。采集器或数据库异常时，页面的数据状态会显示异常；保留的数据或仓库回退快照并不表示采集仍在正常进行。MySQL 连接失败不会偷偷改写本地 SQLite 作为替代存储。

## 本机训练

线上服务无需安装机器学习训练依赖。准备训练时，在本机使用同一 MySQL 配置：

```bash
uv sync --extra ml
uv run --env-file .env observatory train
```

`train` 默认读取 MySQL 中最近一次成功采集的完整历史，并以该次成功观察时间作为截止时间。它不会把当前系统时间直接当成连续观测截止时间。当前训练方式属于**回顾性训练**：早期样本使用的是最新整理后的历史，报告会保留首次采集信息、各事件首次发现时间及这项限制。

默认产生两个被 Git 忽略的本地文件：

- `var/training/neural_model.json`：可供检查的实验模型权重。
- `var/training/neural-evaluation.json`：时间拆分、基线比较、观察截止时间和数据来源说明。

默认训练不会修改 `observatory/data/neural_model.json`，也不会自动替换线上模型。可通过 `--model`、`--report` 指定其他实验输出位置；更换网站使用的模型是另一个明确的部署步骤。采集任务永远不调用训练命令。

自有文件可以使用 `--history`，但需要有效的观察截止信息：

```bash
uv run --env-file .env observatory train --history /path/to/history.json \
  --observed-until 2026-09-12T00:00:00Z \
  --model var/training/custom-model.json \
  --report var/training/custom-evaluation.json
```

这不会把自有文件导入 MySQL，也不会改动已有采集记录。

## 前瞻样本与预测审计

```bash
uv run --env-file .env observatory export-training
uv run --env-file .env observatory score-forecasts
```

`export-training` 写出 `var/training/prospective-dataset.json`。每个 UTC 日期选第一次成功采集作为预测起点，只用该起点实际可见的历史构造特征。它不会把第一批补录前的日期包装成前瞻样本。成熟且覆盖合格的样本进入 `samples`；尚未满 48 小时、过去事件不足或采集有空档的样本留在 `censored` 并说明原因。

`score-forecasts` 写出 `var/training/forecast-scores.json`，使用已保存的原始预测概率。预测满 48 小时后，使用第一份覆盖该时限的成功源快照确定结果，并计算 24／48 小时 Brier 分数。默认超过 3 小时的成功采集间隔、缺少随访或起点快照，结果为 `unknown`，不会生成“未重置”的负标签。48 小时未满时为 `pending`。

首次满期快照确定的结果不会因数天后的补录而悄悄改写；后续来源修订会标出 `sourceRevisionWarning`。这些分数说明的是当时采集到的来源历史，并非独立核验的实际事件真值。两个审计命令均不训练或部署模型，也不回写已存档预测。

当前 `train` 使用最新历史回顾性训练；导出的前瞻样本用于审计和后续训练流程，不会自动混入这次回顾性评估。

## 数据能证明什么

采集来源是第三方整理的 [公开重置历史](https://codex.gussuriworks.com/zh/history)，不是 OpenAI 官方的完整事件日志。记录的依据可来自社交媒体公告或用量观测，执行时间有精确值和估计值之分。采集完整页面只能说明我们完整读取了该页，无法保证原站没有漏报。

项目初始快照有 43 条记录，其中 35 次符合广泛随机重置训练目标。这个规模不足以证明神经网络能稳定预测；初始评估中神经网络也未胜过简单基线。每小时轮询让观察过程更完整，但相同事件被读取 100 次仍然只是一件事件，日级样本与重叠 48 小时标签也不是独立新事件。

持续采集的价值是增加后续独立事件，保留无事件时段的来源覆盖，并能核查“当时知道什么、当时预测什么、之后观察到什么”。是否采用新模型，需要基于后来积累的数据与基线比较决定。
