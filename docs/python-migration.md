# Python 迁移与功能梳理

## 项目做什么

这是一个 Codex / ChatGPT Work 使用额度重置的非官方观测网站。它收集 X 帖子、用量恢复信息、官方服务状态和人工维护的历史，将**已发生的重置**与**未来重置的概率**分开呈现。历史包含全局强制重置、手动重置机会发放、定期重置参考记录；这些类别不应全部成为同一个预测目标。

原系统主要由 Next.js/React 页面、TypeScript 概率模型与 API、Supabase SQL、Manifest V3 浏览器扩展、命令行监控和 Windows C# 界面组成。原有多个 A/B/C 模型、时序评估、影子模型和命名候选流程属于持续实验／运维体系。

## 当前 Python 路径

```text
原站完整历史页的结构化 JSON → 每小时 Python 采集器 → MySQL 事件版本与观察记录
浏览器扩展的帖子与心跳 → FastAPI → 规则分类 → MySQL
本机 Codex app-server → Python monitor → 额度 Webhook → 恢复记录
                              ↓
                  规范化历史与主统计模型
                              ↓
                public-v1 API / Jinja2 三语页面
                              ↑
       独立小型神经网络 → JSON 权重 → 实验预测卡片
```

| 模块 | 文件 | 已验证范围 |
| --- | --- | --- |
| Web 服务 | `observatory/app.py` | 页面/API 路径、鉴权、请求校验、缓存头 |
| 数据访问 | `observatory/mysql_repository.py`、`observatory/storage.py` | MySQL 应用记录与事务；旧 SQLite／Supabase 适配器兼容 |
| 持续积累 | `observatory/collector.py`、`observatory/collection_store.py` | MySQL 事件版本、首次发现时间、采集覆盖和原始预测存档 |
| 历史规范化 | `observatory/history.py` | 去重、排除定期/局部记录、已有名称、周期参考 |
| 概率计算 | `observatory/probability.py` | 风险率、H30、校准；两个静态原实现对照样本 |
| 规则分类 | `observatory/classification.py` | 完成/预告/暗示/无关，引用与否定安全处理 |
| 线上导入 | `observatory/history_sync.py` | 结构化解析、事件 ID、时间、来源、三语匹配 |
| 神经网络 | `observatory/neural.py` | 按时间验证、标签隔离、纯 Python JSON 权重推理 |
| 本机监控 | `observatory/monitor.py` | 周额度选择、最小字段投递、超时与重连 |
| 网页 | `observatory/templates`、`observatory/static` | 日英中页面、搜索/筛选、时间分布、移动端 |

## 数据与训练

网站以 MySQL 中最近一次成功采集的完整历史为当前来源，不把仓库中旧的参考事件再次混入已修正的线上历史。未成功采集或数据库异常时会标记数据状态异常；仓库内置公开快照仅用于回退展示。新 Webhook 记录也写入 MySQL 并进入聚合。采集器保留各批次实际看到的历史，运行时不覆盖包内 JSON 种子文件。

2026-09-12 抓取到 43 条，剔除 2 条局部补偿、5 条定期/参考及1条周期分类非随机的手动发放后，训练目标为 35 次全局随机重置。目标同时包含全局强制重置和普遍发放的 banked reset，不代表每个账号在同一时刻自动刷新。

训练报告保存来源范围、时间切分、逐条测试预测和指标。未调用 LLM、未使用社交帖子文本作特征、未访问原站私有数据库。三语内容直接读取原站已有译文。

## 明确的迁移边界

- 运行网站、预测计算、采集 API 和本机监控已改为 Python，Jinja2 生成页面。
- 浏览器必须执行的少量网页交互、Chrome 扩展保留 JavaScript，不能直接改为浏览器原生 Python。
- 原 Windows C# GUI 已归档；Python 命令行监控是新的跨平台入口，未重建原窗口界面。
- 不使用 LLM 命名、翻译或分类。名称核对仅使用既有已接受候选与可信事件，不生成新名称。
- 原 A/B/C 影子模型、全部历史治理边界、复杂 X 编辑链推断和旧模型评估脚本保留在 `legacy/typescript`，未冒充完整等价移植。详细数值范围见 `docs/python-model-parity.md`。
- Python 模型拥有独立版本名；本次不是原站生产模型切换，也没有把历史预测改写为新模型结果。
- Supabase 集成已经过请求形状测试；本机没有对原生产数据库执行写入。真实数据库权限和现有部署连接需要部署时检查。
- 新本机监控采用原有基础快照协议、轮询/重连；原 Windows UI 通知及更复杂的客户端候选缓冲流程未移植。
- 新的 banked 额度增加会保存到监控状态，尚不自动生成全局发放历史；已导入的发放记录正常展示。公告可由规则分类，但自由文本中的复杂时间表达尚未完整解析，已有结构化时间窗口仍可使用。

## 开发与部署

当前部署使用 MySQL，真实凭据只通过环境或被 Git 忽略的 `.env` 提供。`docker compose up -d --build` 启动 `web` 和每小时运行的 `collector`，共同连接已有 MySQL，不需要 Redis 或线上训练服务。程序增量创建 `cro_*` 表；必须保持采集器运行，观察数据才会继续积累。只启动网页不会自动采集。

本地开发使用 `uv sync` 后运行 `uv run --env-file .env observatory serve --reload`。需要训练时，在本机运行 `uv sync --extra ml`，再执行 `uv run --env-file .env observatory train`，默认读取 MySQL，输出实验模型和报告到被 Git 忽略的 `var/training`。训练不会自动替换网站使用的模型；Python 构建产物包含模板、静态文件、种子数据和已有推理权重。

SQLite 的 `var/observatory.sqlite3` 仅保留用于离线演示或旧适配器测试；MySQL 部署不会在连接失败时自动改用本地存储。完整配置、前瞻样本与预测审计见 [数据积累说明](data-collection.md)。

原 Vercel Next.js 配置已归档，当前部署使用 Uvicorn 和 Docker Compose。仓库修改不会直接替换第三方原站；原实现的代码审计保留在 Git 与 `legacy/typescript`。

## 验证记录

迁移前基线：原 TypeScript 1,810 项测试、ESLint、TypeScript 类型检查、Next.js 生产构建通过。

Python：pytest 覆盖接口鉴权/无配置/异常请求、重复投递、存储原子性、事件范围、校准数值、时间标签隔离、模型推理一致性、页面转义与三语路由。独立 Chromium 测试覆盖桌面和手机布局、刷新、筛选以及语言页面。最终执行结果见任务交付说明。
