# Codex 重置观测站 · Python

观察 Codex 使用额度重置，汇总已记录事件、官方帖子和服务状态，并估计未来 24／48 小时的随机重置概率。网站使用 **Python 3.12+、FastAPI、Jinja2**；运行网页不需要 Node.js，也不调用 LLM。

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
| 存储与运维 | 本地 SQLite、可选 Supabase、监控心跳、预测记录、名称候选核对、健康检查 |

功能盘点、迁移边界和原代码位置见 [迁移说明](docs/python-migration.md)。模型兼容范围见 [模型对照](docs/python-model-parity.md)。

## 启动

```bash
uv sync
uv run observatory serve --reload
```

打开 [中文页面](http://127.0.0.1:8000/zh)。无需数据库账号或 API Key，默认读取仓库内的公开历史快照，用 SQLite 保存新增记录。快照模式会明确显示数据并非实时；**启动服务不会自动爬取外站**。

如果不使用 uv：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
python -m observatory serve --reload
```

PyCharm：选择项目 `.venv`，使用模块运行配置 `observatory`，参数为 `serve --reload`。

## 获取历史并重新训练

```bash
uv sync --extra ml
uv run observatory sync-history
uv run --extra ml observatory train
```

数据来自 [公开历史页](https://codex.gussuriworks.com/zh/history)。导入文件是 `observatory/data/online_history.json`，来源与抓取时间保存在旁边的 `online_history_metadata.json`；神经网络权重采用可检查的 JSON 保存，不使用 pickle。重新导入后重启开发服务以读取新数据。

也可使用自有历史，明确指定观察截止时间，避免把未观察的日子当作负样本：

```bash
uv run --extra ml observatory train --history /path/to/history.json \
  --observed-until 2026-09-12T00:00:00Z \
  --model /path/to/model.json --report /path/to/evaluation.json
```

目前导入 **43 条记录，35 次符合目标的随机重置**。训练使用 102 个日级样本，按时间划分训练／验证／测试，在边界剔除 48 小时标签重叠。最后 21 个测试日，神经网络平均 Brier 分数为 **0.2586**，历史频率基线为 **0.2565**（越低越好），尚未胜过基线。因此主预测保留统计模型，神经网络以实验预测显示。详见 [训练评估](reports/python-migration/neural-evaluation.md)。

这 35 次是站点已收录的事件，不能等同于逐条独立核验的精确执行时刻。分批重置、时间估计、历史修正和未知的漏报率都会影响训练；日级样本增加也不代表独立重置事件增加。没有使用当前帖子、事后分类或未来公告来构造训练特征。

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

`FETCH_LIVE_STATUS=true` 可开启官方状态查询；Supabase 通过 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 启用，沿用 `supabase/migrations`。Python 集成已使用模拟 HTTP 和本地 SQLite 检验，真实 Supabase/官方状态服务需在部署环境完成连接检查。

## 检查与部署

```bash
uv sync --extra ml
make check
uv run playwright install chromium
uv run pytest -m browser
```

Python CI 执行 lint、类型检查、测试和 wheel/sdist 构建。运行 Docker：

```bash
docker build -t codex-reset-observatory .
docker run --rm -p 8000:8000 -v observatory-data:/app/var codex-reset-observatory
```

Docker 使用已保存的权重，在线推理无需安装训练依赖。SQLite 适合单实例；多实例部署配置 Supabase。网站默认仅本地启动，仓库修改不代表原在线站点已切换到 Python。

## 原实现与许可证

Next.js、TypeScript 运维脚本和 Windows C# 工具已保留在 [legacy/typescript](legacy/typescript)，供审计和继续迁移高级运维功能。它们不参与 Python 启动、构建或推理。历史实验模型 A/B/C、LLM 命名／翻译及完整 X 编辑链处理未宣称等价迁移。

原项目：[Codex Reset Observatory](https://codex.gussuriworks.com/zh)，by Gussuri Works。沿用 [MIT License](LICENSE)。
