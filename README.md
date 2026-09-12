# Codex 重置观测站 · Python

观察 Codex 使用额度重置，汇总已记录事件、官方帖子和服务状态，并估计未来 24／48 小时的随机重置概率。网站使用 **Python 3.12+、FastAPI、Jinja2**；运行网页不需要 Node.js，也不调用 LLM。

网站署名：**allen flux** · [项目仓库](https://github.com/allenflux/codex-reset-observator)

## 主要功能

| 功能 | 当前实现 |
| --- | --- |
| 日／英／中网站 | `/`、`/en`、`/zh`，以及各语言的历史、FAQ、关于页面 |
| 重置历史 | 从原站完整历史页解析结构化 JSON，保留事件 ID、来源、适用范围和时刻精度；不执行网页脚本 |
| 时间分布 | 随机重置时刻和间隔分布、时区切换、最近一个月筛选 |
| 统计预测 | Python 危险率模型、信号权重和校准；两个静态数据快照已与原 TypeScript 数值核对 |
| 神经网络预测 | 7 个历史时间特征 → 8 个 tanh 神经元 → 3 类输出，计算 24／48 小时概率；独立实验卡片 |
| 信号采集 | 保留浏览器扩展 Webhook；Python 规则分类，不使用 Gemini 或其他 LLM |
| 用量监控 | Python 命令行读取本机 Codex app-server 的周额度，服务端保存恢复记录、排除定期／个人重置 |
| 持续积累 | 每小时同步公开历史，MySQL 保存事件版本、首次发现时间、采集成功／失败记录和当时预测 |
| 存储与运维 | MySQL 保存网站新增数据和采集档案；监控心跳、预测记录、名称候选核对、健康检查 |

功能盘点、迁移边界和原代码位置见 [迁移说明](docs/python-migration.md)。模型兼容范围见 [模型对照](docs/python-model-parity.md)。

## 部署网站与持续采集

按 [.env.example](.env.example) 在本地 `.env` 中填写 MySQL 连接配置；已有 `.env` 时保留原文件。不要把真实凭据提交到 Git。Compose 连接已有 MySQL，不需要 Redis。

当前远程 MySQL 使用对外端口 **32768**，应设置 `MYSQL_PORT=32768`。跨服务器连接需要填写数据库服务器实际发布的端口；误填默认端口 `3306` 会导致连接失败。修改 `.env` 后，执行以下命令让两个容器重新读取配置：

```bash
docker compose up -d --force-recreate web collector
docker compose logs --tail=30 web collector
```

线上部署在 `.env` 中设置：

```dotenv
PORT=9090
SITE_URL=
```

```bash
docker compose up -d --build
docker compose ps
docker compose exec collector observatory collection-status --check-fresh
```

Compose 运行 `web` 和 `collector` 两个服务：网站在容器内监听 `0.0.0.0:9090`，默认发布到宿主机 `0.0.0.0:9090`；采集器启动时同步一次，此后默认每小时同步。MySQL 自动创建独立的 `cro_*` 表，保存累计数据；修改 `COLLECTION_INTERVAL_SECONDS` 可调整采集间隔。**必须保持采集器运行，数据才会持续积累。**只启动网页不会自动采集。

部署后访问 [allenflux.tech:9090](http://allenflux.tech:9090/)，也可直接访问 `http://服务器IP:9090/zh`；本机部署访问 [中文页面](http://localhost:9090/zh)。`0.0.0.0` 表示监听所有网络接口，浏览器使用上述实际访问地址。应用无需绑定域名；`SITE_URL` 留空时，页面链接使用当前访问地址。`PORT` 可调整宿主机发布端口，容器内端口保持 `9090`；本地直接运行 `observatory serve` 的默认端口仍为 `8000`。

网站读取最近一次成功采集的完整历史。未成功采集或数据库不可用时，会标记数据状态异常；仓库内快照只用于回退展示。运行中的采集不会修改 `observatory/data`，也不会自动训练或替换模型。

采集内容、存储结构、训练与检查步骤见 [数据积累说明](docs/data-collection.md)。

## 本地启动

```bash
uv sync
uv run --env-file .env observatory serve --reload
```

打开 [中文页面](http://127.0.0.1:8000/zh)。本地服务和线上采集器使用同一份 MySQL 数据。仅查看离线演示时，可不加载 `.env` 运行 `uv run observatory serve --reload`，读取随项目提供的公开快照；这不代表持续采集已经开启。

如果不使用 uv：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
python -m observatory serve --reload
```

PyCharm：选择项目 `.venv`，使用模块运行配置 `observatory`，参数为 `serve --reload`，并在运行配置中加载需要的环境变量。普通 `python -m` 不会自动读取 `.env`。

## 本地训练与前瞻评估

线上只运行网站和采集器，训练在本机按需执行，直接读取同一个 MySQL，无需从服务器下载数据文件，也不需要 Redis 或本地训练容器。以下命令均在项目根目录执行，需要 **Python 3.12+ 和 uv**，以及能连接 MySQL 的网络。

### 1. 准备环境并检查数据

本地 `.env` 参照 [.env.example](.env.example) 配置 `COLLECTION_BACKEND=mysql` 和 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_DATABASE`、`MYSQL_USER`、`MYSQL_PASSWORD`；已有配置时直接复用，不覆盖原文件。`.env` 和 `var/` 已被 Git 忽略。

```bash
uv sync --extra ml
uv run --env-file .env observatory collection-status
```

检查 `latestSuccessfulAt`、`currentEventCount` 和 `fresh`，确认已有成功采集且数据更新时间符合预期。`runCount` 是采集次数，`eventVersionCount` 包含历史修订，都不等于独立重置次数。如果还没有成功采集，可以手动执行一次：

```bash
uv run --env-file .env observatory collect --once
```

日常积累交给线上 `collector`；不必为训练另开一个本地常驻采集器。`sync-history` 也等同于单次采集，写入数据库。

### 2. 在本机训练

```bash
uv run --env-file .env --extra ml observatory train
# 等效的快捷命令
make train
```

两条命令任选其一。训练读取最近一次成功采集的历史，以该次采集时间作为观察截止时间，按时间划分训练／验证／测试，并剔除边界处 48 小时标签重叠。最低需要 45 个标签窗口已满 48 小时的日级样本，训练部分还必须覆盖三种结果类别；这只是程序可训练的条件，不代表数据足以可靠预测。每小时重复抓取同一批记录不会增加独立重置事件。

默认生成以下本地文件，重复训练会覆盖同名文件；可通过 `COLLECTION_OUTPUT_DIR` 调整默认目录。

| 文件 | 内容 |
| --- | --- |
| `var/training/neural_model.json` | 可检查的 JSON 模型权重、训练时间、数据指纹；不使用 pickle |
| `var/training/neural-evaluation.json` | 数据质量、样本与时间划分、测试集指标、基线对照、数据库采集来源 |

要保留不同训练版本，为每次运行指定不同目录，例如：

```bash
uv run --env-file .env --extra ml observatory train \
  --model var/training/run-001/neural_model.json \
  --report var/training/run-001/neural-evaluation.json
```

后续把 `run-001` 换成 `run-002` 等名称。训练输出留在本机，**不会自动上传、修改 MySQL 历史或替换网站正在使用的模型**。

### 3. 查看训练结果

终端会打印主要指标，完整信息在评估 JSON 中：`sampleCount` 是日级样本数，`dataQuality` 记录符合训练口径的事件及排除原因；`neural` 与 `baselines` 在相同测试集上比较。Brier 分数越低越好，`relativeBrierImprovement` 为正表示平均分数优于最佳基线，为负表示更差；还应检查 24／48 小时两个指标和 `beatsBaselineBothHorizons`。

当前 `train` 对最新历史做**回顾性训练**，报告的 `collectionProvenance` 保留观察截止时间和首次发现信息。历史补录、修订及未核实的来源完整性会影响结果；一次回测领先不能当成前瞻验证通过。输出始终标记 `deploymentStatus=experimental`，是否采用新模型需要另行评估和更新。

### 4. 导出前瞻样本和评估已存档预测

```bash
uv run --env-file .env observatory export-training
uv run --env-file .env observatory score-forecasts
```

分别输出 `var/training/prospective-dataset.json` 和 `var/training/forecast-scores.json`；可用 `--output var/training/run-001/文件名.json` 单独保存。`export-training` 依据每个 UTC 日首个成功采集时点实际可见的历史生成日级样本；`score-forecasts` 评估采集器当时存档的预测，并不评估刚训练出的本地模型。

未满 48 小时的记录标记 `pending`；缺少后续采集或默认超过 3 小时的采集空档标记 `unknown`，不当成“没有重置”。初次启动时没有成熟样本是正常情况。这两个命令只导出审计数据，不触发训练；目前 `train` 默认仍读取最新历史，前瞻导出文件也不是 `--history` 所需的事件列表格式。

### 其他运行方式

**PyCharm：**先运行 `uv sync --extra ml`，选择项目 `.venv` 解释器，创建 Python 模块运行配置：模块名 `observatory`、参数 `train`、工作目录为项目根目录；在配置中注入 `.env` 对应的环境变量。普通 `python -m observatory train` 不会自动读取 `.env`。要保留多个实验，在参数中加上 `--model` 和 `--report`。

也可使用自有历史，明确指定观察截止时间，避免把未观察的日子当作负样本：

```bash
uv run --env-file .env --extra ml observatory train --history /path/to/history.json \
  --observed-until 2026-09-12T00:00:00Z \
  --model /path/to/model.json --report /path/to/evaluation.json
```

自有历史应为与 `observatory/data/online_history.json` 相同结构的事件列表；把示例路径和截止时间换成实际值。直接从 MySQL 训练时，不传 `--history` 或 `--observed-until`。

### 初始评估参考

首次导入 **43 条记录，35 次符合目标的随机重置**。初始训练使用 102 个日级样本；最后 21 个测试日，神经网络平均 Brier 分数为 **0.2586**，历史频率基线为 **0.2565**，尚未胜过基线。因此主预测保留统计模型，神经网络以实验预测显示。以上是初始评估快照，不是当前 MySQL 计数；后续运行以本地报告为准。详见 [训练评估](reports/python-migration/neural-evaluation.md)。

数据来自第三方整理的 [公开历史页](https://codex.gussuriworks.com/zh/history)，不是 OpenAI 提供的完整重置事件日志。这 35 次是站点已收录的事件，不能等同于逐条独立核验的精确执行时刻，也不足以证明神经网络具有稳定预测能力。分批重置、时间估计、历史修正和未知的漏报率都会影响训练；每小时抓取成功并不增加独立重置事件数。累计数据保留初始历史补录和后续实际观察的区别；前瞻导出只使用各预测时点已采集的信息，回顾性训练不具备同样保证。

## API 与监控

- `GET /api/current?locale=zh`：公开 `public-v1` 快照。
- `GET /api/reset-marker`：供浏览器检查最新恢复标记。
- `POST /api/webhook/tibo`、`POST /api/webhook/tibo/heartbeat`：帖子和心跳。
- `POST /api/webhook/codex-usage`：本机额度快照。
- `POST /api/log-probability`：记录当前主模型预测。
- `GET /api/monitor/health`、`POST /api/internal/reconcile-reset-display-names`：受保护的运维接口。
- `GET /healthz`：存活检查。

Webhook 必须设置对应 secret 并携带 `Authorization: Bearer …`；未配置时写接口返回 503，不开放匿名写入。环境变量名见 [.env.example](.env.example)，通过进程环境或部署平台传入真实值，不要提交密钥文件。

已有本机 Codex CLI 并登录后，配置 `CODEX_USAGE_MONITOR_SECRET`（与服务端一致），再运行：

```bash
uv run observatory monitor-usage
# 单次采样
uv run observatory monitor-usage --once
```

默认 Webhook 为本地地址；远程地址必须 HTTPS。仅发送白名单额度字段，不发送账号响应原文。浏览器扩展仍使用 [原生 JavaScript](extension/tibo-monitor/README.md)，在扩展设置中配置你的 Python 服务 URL。

`FETCH_LIVE_STATUS=true` 可开启官方状态查询。本次部署统一使用 MySQL；旧 SQLite／Supabase 适配器保留供兼容和测试使用，不需要额外配置它们。

## 检查与部署

```bash
uv sync --extra ml
make check
uv run playwright install chromium
uv run pytest -m browser
```

Python CI 执行 lint、类型检查、测试和 wheel/sdist 构建。Docker 使用已保存的权重，在线推理无需训练依赖；采集器与网站共享 MySQL。容器重启后从数据库继续积累，服务停止期间的缺口不会伪装成连续观测。仓库修改不代表原在线站点已切换到 Python。

## 原实现与许可证

Next.js、TypeScript 运维脚本和 Windows C# 工具已保留在 [legacy/typescript](legacy/typescript)，供审计和继续迁移高级运维功能。它们不参与 Python 启动、构建或推理。历史实验模型 A/B/C、LLM 命名／翻译及完整 X 编辑链处理未宣称等价迁移。

原项目：[Codex Reset Observatory](https://codex.gussuriworks.com/zh)，by Gussuri Works。沿用 [MIT License](LICENSE)。
