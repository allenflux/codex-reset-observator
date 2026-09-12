import SwiftUI

enum ObservatoryTheme {
    static let background = Color(red: 0.045, green: 0.075, blue: 0.085)
    static let card = Color(red: 0.08, green: 0.12, blue: 0.13)
    static let mint = Color(red: 0.55, green: 0.92, blue: 0.73)
}

struct ContentView: View {
    @State private var selection = 0

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack { DashboardView() }
                .tabItem { Label("观测", systemImage: "waveform.path.ecg") }.tag(0)
            NavigationStack { HistoryView() }
                .tabItem { Label("历史", systemImage: "clock.arrow.circlepath") }.tag(1)
            NavigationStack { SettingsView() }
                .tabItem { Label("设置", systemImage: "slider.horizontal.3") }.tag(2)
        }
        .onOpenURL { url in
            guard url.scheme?.lowercased() == "codexreset" else { return }
            selection = url.host == "history" ? 1 : 0
        }
    }
}

struct DashboardView: View {
    @EnvironmentObject private var store: ObservatoryStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 7) {
                    Circle().fill(store.snapshot?.dataHealth.stale == false ? ObservatoryTheme.mint : .orange)
                        .frame(width: 7, height: 7)
                    Text(store.snapshot?.dataHealth.stale == false ? "持续观测中" : "等待最新数据")
                        .font(.caption.weight(.medium))
                    Spacer()
                    if store.isRefreshing { ProgressView().controlSize(.small) }
                }
                .foregroundStyle(.secondary)
                Text("下一次重置，\n心里有数。")
                    .font(.system(size: 34, weight: .semibold, design: .rounded))
                    .fixedSize(horizontal: false, vertical: true)

                if let message = store.errorMessage {
                    MessageBanner(text: "\(message)\(store.snapshot == nil ? "" : " 当前保留上次成功获取的数据。")", symbol: "wifi.exclamationmark")
                }
                if let snapshot = store.snapshot {
                    snapshotContent(snapshot)
                } else if !store.isRefreshing {
                    ContentUnavailableView {
                        Label("还没有观测数据", systemImage: "antenna.radiowaves.left.and.right")
                    } description: {
                        Text("检查设置中的服务器地址，然后下拉刷新。")
                    } actions: {
                        Button("重新连接") { Task { await store.refresh() } }
                    }
                } else {
                    ProgressView("正在连接观测所…")
                        .frame(maxWidth: .infinity).padding(.vertical, 70)
                }
            }
            .padding(20)
            .frame(maxWidth: 700)
            .frame(maxWidth: .infinity)
        }
        .background(ObservatoryTheme.background)
        .navigationTitle("重置观测所")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
    }

    @ViewBuilder private func snapshotContent(_ snapshot: ObservatorySnapshot) -> some View {
        if snapshot.dataHealth.stale || snapshot.dataHealth.overall != "ok" {
            MessageBanner(text: "部分来源延迟或不可用。当前记录与预测可能尚未反映最新情况。", symbol: "clock.badge.exclamationmark")
        }
        if snapshot.viewModel.hasOfficialNotice, let notice = snapshot.viewModel.activeWindow {
            ObservatoryCard {
                Label("官方已预告 · 等待执行", systemImage: "megaphone.fill")
                    .font(.headline).foregroundStyle(ObservatoryTheme.mint)
                Text(notice.summary ?? "已收到重置公告，尚未确认执行。")
                if let timing = notice.timingText, !timing.isEmpty {
                    Text(timing).font(.subheadline).foregroundStyle(.secondary)
                }
                if notice.timingUnresolved != true, let expected = DisplayFormat.date(notice.expectedAt) {
                    DateLabel(date: expected, prefix: "预计")
                }
                if notice.isOverduePending == true {
                    Text("预告时间已过，仍在等待执行确认。")
                        .font(.footnote).foregroundStyle(.orange)
                }
                if let url = DisplayFormat.safeLink(notice.source) {
                    Link("查看原始公告 ↗", destination: url).font(.footnote)
                }
            }
        }

        ObservatoryCard {
            HStack {
                Text(snapshot.viewModel.hasOfficialNotice ? "历史模型参考" : "随机重置预测").font(.headline)
                Spacer()
                if snapshot.viewModel.primaryForecast?.experimental == true {
                    Text("实验模型").font(.caption2.weight(.medium))
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(.white.opacity(0.07), in: Capsule())
                }
            }
            HStack(spacing: 22) {
                ProbabilityView(title: "未来 24 小时", value: snapshot.viewModel.probability24h)
                Rectangle().fill(.white.opacity(0.1)).frame(width: 1, height: 60)
                ProbabilityView(title: "未来 48 小时", value: snapshot.viewModel.probability48h)
            }
            .padding(.vertical, 10)
            Text(snapshot.viewModel.displayReasoningSummary ?? "根据历史记录估计。")
                .font(.caption).foregroundStyle(.secondary)
            Text(snapshot.viewModel.hasOfficialNotice
                 ? (snapshot.viewModel.primaryForecast?.includesAnnouncement == false
                    ? "此概率未纳入当前公告，也不代表公告兑现的概率。"
                    : "此概率仅供参考，不代表公告兑现的概率或已确认执行。")
                 : "预测仅供参考，不代表官方时间表或你的账号已获得重置。")
                .font(.caption).foregroundStyle(.secondary)
        }

        if let latest = snapshot.viewModel.recentHistory.first {
            ObservatoryCard {
                Label("最近记录", systemImage: "checkmark.circle").font(.headline)
                RecordRow(record: latest)
                NavigationLink("查看记录详情") { RecordDetailView(record: latest) }.font(.footnote)
            }
        }

        ObservatoryCard {
            Label("下一次定期重置", systemImage: "calendar").font(.headline)
            if let expected = DisplayFormat.date(snapshot.viewModel.regularResetForecast?.expectedAt) {
                Text(expected, format: .dateTime.month(.abbreviated).day().hour().minute())
                    .font(.title2.weight(.semibold))
                if let remaining = snapshot.viewModel.regularResetForecast?.remaining {
                    Text(remaining).font(.subheadline).foregroundStyle(ObservatoryTheme.mint)
                }
            } else {
                Text("尚未确定").font(.title3).foregroundStyle(.secondary)
            }
            Text("按历史周期推算，具体以你的账号用量窗口为准。时间均为设备本地时间。")
                .font(.caption).foregroundStyle(.secondary)
        }

        if let activity = snapshot.latestTiboActivity, let text = activity.text, !text.isEmpty {
            ObservatoryCard {
                Label("最新相关动态", systemImage: "text.bubble").font(.headline)
                Text(text).font(.subheadline).textSelection(.enabled)
                if let date = DisplayFormat.date(activity.createdAt) { DateLabel(date: date) }
                if let url = DisplayFormat.safeLink(activity.sourceUrl) {
                    Link("查看原文 ↗", destination: url).font(.footnote)
                }
            }
        }

        VStack(alignment: .leading, spacing: 6) {
            if let checked = DisplayFormat.date(snapshot.checkedAt) { DateLabel(date: checked, prefix: "数据检查") }
            if let received = store.lastReceivedAt { DateLabel(date: received, prefix: "本机刷新") }
            Text("独立、非官方观测工具 · by allen flux").font(.caption2).foregroundStyle(.secondary)
        }.padding(.vertical, 5)
    }
}

struct ProbabilityView: View {
    let title: String
    let value: Double?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(DisplayFormat.percent(value))
                .font(.system(size: 43, weight: .medium, design: .rounded))
                .foregroundStyle(ObservatoryTheme.mint).minimumScaleFactor(0.6).lineLimit(1)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ObservatoryCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .background(ObservatoryTheme.card, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(.white.opacity(0.055), lineWidth: 1))
    }
}

struct MessageBanner: View {
    let text: String
    let symbol: String
    var body: some View {
        Label(text, systemImage: symbol)
            .font(.footnote).foregroundStyle(.orange)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14).background(.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 14))
    }
}

struct DateLabel: View {
    let date: Date
    var prefix: String = ""
    var body: some View {
        HStack(spacing: 5) {
            if !prefix.isEmpty { Text(prefix) }
            Text(date, format: .dateTime.year().month(.twoDigits).day().hour().minute())
        }.font(.caption).foregroundStyle(.secondary)
    }
}

struct HistoryView: View {
    @EnvironmentObject private var store: ObservatoryStore
    @State private var query = ""
    @State private var kind = "all"
    private var records: [ResetRecord] {
        (store.snapshot?.viewModel.recentHistory ?? []).filter {
            (kind == "all" || $0.recordKind == kind) &&
            (query.isEmpty || ($0.title + ($0.summary ?? "")).localizedCaseInsensitiveContains(query))
        }
    }

    var body: some View {
        List {
            Section {
                Picker("记录类型", selection: $kind) {
                    Text("全部记录").tag("all")
                    Text("全局重置").tag("confirmed_global")
                    Text("Banked Reset").tag("banked_distribution")
                    Text("定期重置").tag("regular_completed")
                    Text("参考记录").tag("reference")
                }.tint(ObservatoryTheme.mint)
            }
            if let error = store.errorMessage {
                Section { Text(error).font(.footnote).foregroundStyle(.orange) }
            }
            Section {
                ForEach(records) { record in
                    NavigationLink { RecordDetailView(record: record) } label: { RecordRow(record: record) }
                }
            } header: {
                Text("\(records.count) 条记录 · 时间为设备本地时间")
            }
            if records.isEmpty {
                ContentUnavailableView("暂无匹配记录", systemImage: "clock", description: Text("下拉刷新，或调整筛选条件。"))
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden).background(ObservatoryTheme.background)
        .navigationTitle("重置历史")
        .searchable(text: $query, prompt: "搜索名称或说明")
        .refreshable { await store.refresh() }
    }
}

struct RecordRow: View {
    let record: ResetRecord
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(record.kindLabel).font(.caption.weight(.medium)).foregroundStyle(ObservatoryTheme.mint)
            Text(record.title).font(.headline).foregroundStyle(.primary)
            if let date = record.timestamp { DateLabel(date: date) }
            if let summary = record.summary, !summary.isEmpty {
                Text(summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
            }
        }.padding(.vertical, 6)
    }
}

struct RecordDetailView: View {
    let record: ResetRecord
    var body: some View {
        ScrollView {
            ObservatoryCard {
                Text(record.kindLabel).font(.subheadline).foregroundStyle(ObservatoryTheme.mint)
                Text(record.title).font(.title2.bold())
                if let date = record.timestamp { DateLabel(date: date, prefix: "记录时间") }
                if let summary = record.summary, !summary.isEmpty { Text(summary).textSelection(.enabled) }
                if let scope = record.scope, !scope.isEmpty {
                    Text("适用范围：\(scope)").font(.subheadline).foregroundStyle(.secondary)
                }
                if record.recordKind == "reference" {
                    Text("这是参考记录，不表示已确认发生全局重置。")
                        .font(.footnote).foregroundStyle(.orange)
                }
                if let url = DisplayFormat.safeLink(record.source) {
                    Link("查看来源 ↗", destination: url)
                }
            }.padding(20)
        }
        .background(ObservatoryTheme.background)
        .navigationTitle("记录详情").navigationBarTitleDisplayMode(.inline)
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: ObservatoryStore
    @State private var serverDraft = ""
    @State private var secretDraft = ""
    @State private var settingsMessage: String?

    var body: some View {
        Form {
            Section {
                TextField("服务器地址", text: $serverDraft)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityLabel("服务器地址")
                Button("保存并连接") {
                    do {
                        try store.saveServer(serverDraft)
                        serverDraft = store.serverText
                        settingsMessage = "服务器地址已保存。"
                        Task { await store.refresh() }
                    } catch { settingsMessage = error.localizedDescription }
                }
            } header: { Text("连接") } footer: {
                Text("支持 HTTP 与 HTTPS，可直接连接你的服务器或局域网地址。")
            }

            Section {
                LabeledContent("接收方式", value: "Telegram")
                if let status = store.mobileStatus {
                    LabeledContent("服务器通知", value: status.enabled ? "已启用" : status.configured ? "已暂停" : "未配置")
                    if let checked = DisplayFormat.date(status.lastCheckedAt) { DateLabel(date: checked, prefix: "最近检查") }
                    if let sent = DisplayFormat.date(status.lastSentAt) { DateLabel(date: sent, prefix: "最近发送") }
                    if status.pendingCount > 0 {
                        LabeledContent("等待发送", value: "\(status.pendingCount) 条")
                    }
                    if status.enabled && status.workerFresh == false {
                        Label("通知采集器尚未启动或检查已过期，请检查服务器。", systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(.orange)
                    }
                    if let failed = status.failedCount, failed > 0 {
                        Label("\(failed) 条通知发送失败，请检查 Telegram 配置。", systemImage: "exclamationmark.bubble")
                            .font(.footnote).foregroundStyle(.orange)
                    } else if status.lastError != nil {
                        Text("最近一次通知检查或发送失败，请检查服务器状态。")
                            .font(.footnote).foregroundStyle(.orange)
                    }
                } else {
                    Text(store.mobileStatusError ?? "正在读取通知服务状态…")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Link("安装或打开 Telegram ↗", destination: URL(string: "https://telegram.org/apps")!)
            } header: { Text("重置提醒") } footer: {
                Text("重置由服务器持续监测，通知显示在 Telegram。请安装 Telegram、允许通知，并在服务器配置 Telegram Bot；无需保持观测所 App 打开。")
            }

            Section {
                SecureField("测试密钥", text: $secretDraft)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityLabel("测试密钥")
                Button("保存测试密钥") {
                    do {
                        let secret = secretDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !secret.contains(where: \.isWhitespace) else {
                            settingsMessage = "测试密钥不能包含空格或换行。"
                            return
                        }
                        try SecureStore.save(secret, server: store.server)
                        secretDraft = secret
                        settingsMessage = secret.isEmpty ? "测试密钥已移除。" : "测试密钥已保存到本机钥匙串。"
                    } catch { settingsMessage = error.localizedDescription }
                }
                Button {
                    Task { await store.sendTest() }
                } label: {
                    HStack {
                        Text("发送测试通知")
                        if store.isTesting { Spacer(); ProgressView() }
                    }
                }
                .disabled(store.mobileStatus?.testAvailable != true || store.isTesting)
                if let result = store.testResult { Text(result).font(.footnote).foregroundStyle(.secondary) }
            } header: { Text("测试通知（可选）") } footer: {
                Text("填写服务器的 MOBILE_API_SECRET，仅用于发送测试；日常重置通知无需填写。密钥保存在本机钥匙串，与服务器地址绑定。HTTP 连接会明文传输测试密钥。")
            }

            if let message = settingsMessage {
                Section { Text(message).font(.footnote).foregroundStyle(ObservatoryTheme.mint) }
            }
            Section {
                LabeledContent("版本", value: "1.0")
                Text("支持免费 Apple ID 签名安装。观测所在前台每分钟刷新，也可下拉刷新；锁屏推送由 Telegram 接收。")
                    .font(.footnote).foregroundStyle(.secondary)
            } header: { Text("关于") }
        }
        .scrollContentBackground(.hidden).background(ObservatoryTheme.background)
        .navigationTitle("设置")
        .refreshable { await store.refresh() }
        .task(id: store.serverText) {
            serverDraft = store.serverText
            do { secretDraft = try SecureStore.read(server: store.server) }
            catch { secretDraft = ""; settingsMessage = error.localizedDescription }
        }
    }
}
