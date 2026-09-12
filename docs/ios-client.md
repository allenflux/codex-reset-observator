# iPhone 客户端与 Telegram 重置通知

先把原生 SwiftUI 客户端从 Xcode 安装到自己的 iPhone，即可查看重置记录和预测。客户端默认连接 [观测所 HTTP 服务](http://allenflux.tech:9090)，支持免费 Apple ID，无需上架 App Store，服务器无需配置 HTTPS。Telegram 通知可以随后单独配置；未启用或未配置完整时不会发送消息。

后台和锁屏消息由手机上的 Telegram 接收。免费 Personal Team 无法给自己的 App 启用 APNs 远程推送能力，因此由服务器向自己指定的 Telegram 私聊发送通知。客户端关闭或签名过期时，只要服务器采集器继续运行，Telegram 仍可收信。Apple 的能力要求见 [iOS 能力表](https://developer.apple.com/help/account/reference/supported-capabilities-ios)。

## 1. 从 Xcode 安装原生客户端

需要 Mac 上的完整 Xcode，以及 iOS 17 或更新版本的 iPhone；Xcode 版本需支持手机当前的 iOS 版本。工程无第三方包依赖。

1. 在 Xcode 中打开项目根目录下的 `ios/ResetObservatory.xcodeproj`，选择共享 scheme `ResetObservatory`。
2. 在 Xcode 的 Settings → Accounts 中登录免费 Apple ID。
3. 选择 `ResetObservatory` target → Signing & Capabilities，启用 Automatically manage signing，把 Team 设为自己的 Personal Team。
4. 将 Bundle Identifier 改为自己唯一的名称，例如 `com.yourname.resetobservatory`。无需添加 Push Notifications 或后台运行能力。
5. 连接并解锁 iPhone，按手机提示信任这台 Mac。在 iPhone 的“设置 → 隐私与安全性 → 开发者模式”中启用开发者模式，并完成重启确认。详见 [Apple 开发者模式说明](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)。
6. 在 Xcode 顶部选择这台 iPhone，点击 Run，完成安装。若手机提示开发者尚未受信任，按系统提示到“设置 → 通用 → VPN 与设备管理”中信任对应开发者。

Apple 当前规定 Personal Team 的描述文件自签发起 **7 天后过期**；过期后重新连接手机，在 Xcode 中再次构建安装。详见 [Apple 免费账号与 Personal Team 说明](https://developer.apple.com/help/account/basics/about-your-developer-account)。这是自己构建的客户端的签名周期，Telegram 的 App Store 安装不使用这份 Personal Team 描述文件。

## 2. 在手机连接观测所

打开“重置观测所”的设置页，确认“服务器地址”为 `http://allenflux.tech:9090`，点击“保存并连接”。这里填写服务器根地址，结尾不需要 `/api/current`。也可填写手机能够访问的局域网 HTTP 地址；首次连接局域网时允许系统的本地网络访问请求。

客户端在前台约每 60 秒刷新，也支持下拉刷新。查看历史、预测等公开数据无需 Telegram Token 或测试密钥。Telegram 尚未配置时，可正常使用客户端，之后再启用通知。

## 3. 创建自己的 Telegram Bot

1. 在 iPhone 安装 [Telegram 官方客户端](https://telegram.org/apps)，登录并允许通知。
2. 打开官方 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，按提示设置 Bot 名称和用户名，取得 Bot Token。创建流程见 [Telegram 官方 BotFather 说明](https://core.telegram.org/bots/features#creating-a-new-bot)。
3. 打开刚创建的 Bot 的私聊，点击 Start 或发送 `/start`。这条消息应发给自己的 Bot。Telegram 要求用户先主动联系 Bot，Bot 才能向用户发送消息，见 [官方 Bot 说明](https://core.telegram.org/bots#how-are-bots-different-from-humans)。
4. 将 Token 私下填写到部署服务器的 `TELEGRAM_BOT_TOKEN` 环境变量。Token 只保存在服务器私有环境中，不要发到这里的聊天、日志或 Git，也不要填入原生客户端。Token 应视同密码，见 [Telegram 官方教程](https://core.telegram.org/bots/tutorial#obtain-your-bot-token)。

为观测所创建一个专用 Bot 即可，无需安装其他 Bot 框架或配置 webhook。本项目由服务器主动请求 Telegram 官方 Bot API；观测所仍可使用 HTTP。

## 4. 配置服务器并获取自己的 Chat ID

在部署服务器上编辑项目现有的 `.env`，保留已有 MySQL 配置，补充以下字段。先保持发送关闭，只填写 Bot Token；示例中的密钥和 Chat ID 故意为空。

```dotenv
TELEGRAM_ENABLED=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
MOBILE_API_SECRET=
SITE_URL=http://allenflux.tech:9090
COLLECTION_INTERVAL_SECONDS=300
NOTIFICATION_INTERVAL_SECONDS=30
NOTIFICATION_MAX_EVENT_AGE_SECONDS=86400
```

从服务器的项目目录构建并启动服务，让容器读取 Token：

```sh
docker compose up -d --build web collector
docker compose exec collector observatory telegram-chat-id
```

`telegram-chat-id` 从进程环境读取 Token，调用 Telegram 官方 `getUpdates`，只输出候选私聊 Chat ID，不显示 Token、用户名或聊天内容，也不发送消息。将自己与这个专用 Bot 的私聊 ID 私下填入 `TELEGRAM_CHAT_ID`。若有多个候选，需要确认并选择自己的私聊，不能随意选别人的 ID。

如果没有候选，先向自己的 Bot 再发一次 `/start`，再运行同一个命令。此辅助命令适用于专用、没有 webhook 或其他更新消费者的 Bot；已有 webhook 与 `getUpdates` 不兼容，不要因此移除其他项目的 webhook。接口限制见 [Telegram getUpdates 文档](https://core.telegram.org/bots/api#getupdates)。

确认 Token 和自己的 Chat ID 都已填写后，把开关改为：

```dotenv
TELEGRAM_ENABLED=true
```

`MOBILE_API_SECRET` 是自己另外设置的测试密钥：可以留空，自动重置通知照常工作；填写后才能在客户端发送测试通知。不要复用 Telegram Token、Apple 密码或其他服务凭据。观测所使用 HTTP，测试请求中的密钥也通过 HTTP 传输。手机只需要这个可选测试密钥，Bot Token 和 Chat ID 留在服务器。

重新创建服务，使最终配置生效：

```sh
docker compose up -d --build web collector
docker compose exec collector observatory collection-status --check-fresh
```

保持 `web`、`collector` 和 MySQL 运行。通知去重与发送状态保存在数据库中，正常重启容器会保留；删除数据库会重建通知基线。每次修改 `.env` 后都需要重新创建相关容器。

历史采集默认每小时一次；上面的 `COLLECTION_INTERVAL_SECONDS=300` 将其改为约每 5 分钟一次。`NOTIFICATION_INTERVAL_SECONDS=30` 是检查待发送通知的间隔，不能让上游历史提前更新。实际通知延迟还包括上游公布、采集请求和 Telegram 消息传递时间。

## 5. 在手机测试 Telegram 通知

如果服务器设置了 `MOBILE_API_SECRET`，在原生客户端设置页的“测试密钥”中输入相同值，点击“保存测试密钥”，再点击“发送测试通知”。该密钥保存在 iPhone Keychain 中，并按服务器地址隔离；切换服务器后需为新服务器单独配置。测试消息发送到服务器配置的 **Telegram 私聊**。

测试按钮仅在服务器允许测试时启用，每 60 秒最多发送一次。成功响应表示 Telegram 已接受消息，实际手机提醒还取决于网络、Telegram 的系统通知权限、聊天是否静音以及专注模式。可锁屏后确认是否收到提醒。

锁屏期间无需保持原生客户端运行；服务器负责发现和发送通知。此流程需在自己的手机上完成安装和收信确认，仓库中的构建或自动化检查不等于已经通过实机通知验证。

## 通知范围与行为

- 仅通知采集器新记录的、已经完成的广泛随机重置，或面向广泛用户的手动重置机会发放。手动重置机会会使用单独文案，不表示账号已自动恢复额度。
- 定期重置、个人重置、条件限定事件、参考记录、预告和预测不会触发这条通知通道。消息反映公开历史中的事件，不保证自己的账号额度已经恢复；本功能也不直接读取自己的账号。
- 首次启用时，将已存在的历史建立为基线，不补发整段历史。超过 24 小时的旧事件补录默认不通知；该窗口由 `NOTIFICATION_MAX_EVENT_AGE_SECONDS` 控制。
- 按稳定事件 ID 持久去重。重复采集、通常的文案或时间修订、容器重启不会再次发送同一事件。
- 临时发送失败会持久保存并退避重试，最多尝试 5 次；永久性错误会停止重试。若 Telegram 已接收消息，但网络超时或进程在确认前退出，重试可能产生少量重复消息，不保证严格只送达一次。

## 接口与排查

| 接口 | 用途 | 鉴权 |
| --- | --- | --- |
| `GET /api/current?locale=zh` | 原生客户端读取现有公开状态与历史 | 无 |
| `GET /api/mobile/status` | 查看 Telegram 通知配置与运行状态，不返回凭据 | 无 |
| `POST /api/mobile/test`，JSON 请求体 `{}` | 向服务器已配置的 Telegram 私聊发送测试 | `Authorization: Bearer <MOBILE_API_SECRET>` |

浏览器可直接打开 [移动通知状态](http://allenflux.tech:9090/api/mobile/status)。测试请使用客户端按钮；获取 Chat ID 请使用上述辅助命令，不要把 Bot Token 拼进浏览器地址或终端命令，也不要开启包含 Telegram 请求 URL 的调试日志。

若读取数据失败，先确认手机能打开 [HTTP 网站](http://allenflux.tech:9090)，并检查端口 `9090` 与防火墙设置。若可以读取但无法测试，确认后端已更新，`TELEGRAM_ENABLED`、Token、自己的 Chat ID 和测试密钥均已配置，并重新创建容器。若 Telegram 拒收，确认已经向自己的 Bot 发送 `/start`，且没有屏蔽该 Bot。若测试收到而自动通知未收到，先检查采集新鲜度；初始化基线、旧历史、定期事件和尚未正式记录的预告都不会触发通知。
