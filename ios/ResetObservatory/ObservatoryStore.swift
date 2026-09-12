import Combine
import Foundation

@MainActor
final class ObservatoryStore: ObservableObject {
    @Published private(set) var serverText: String
    @Published private(set) var snapshot: ObservatorySnapshot?
    @Published private(set) var lastReceivedAt: Date?
    @Published private(set) var isRefreshing = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var mobileStatus: MobileStatus?
    @Published private(set) var mobileStatusError: String?
    @Published private(set) var isTesting = false
    @Published private(set) var testResult: String?

    let api = APIClient()
    private var revision = UUID()
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let saved = defaults.string(forKey: "serverAddress") ?? ServerAddress.defaultValue
        serverText = (try? ServerAddress(saved))?.url.absoluteString ?? ServerAddress.defaultValue
    }

    var server: ServerAddress { try! ServerAddress(serverText) }

    func saveServer(_ value: String) throws {
        let address = try ServerAddress(value)
        guard address.url.absoluteString != serverText else { return }
        revision = UUID()
        serverText = address.url.absoluteString
        defaults.set(serverText, forKey: "serverAddress")
        snapshot = nil
        lastReceivedAt = nil
        errorMessage = nil
        mobileStatus = nil
        mobileStatusError = nil
        testResult = nil
        isRefreshing = false
    }

    func refresh() async {
        guard !isRefreshing else { return }
        let requestRevision = revision
        let address = server
        isRefreshing = true
        defer { if revision == requestRevision { isRefreshing = false } }
        async let statusRefresh: Void = refreshMobileStatus(address: address, requestRevision: requestRevision)
        do {
            let result = try await api.snapshot(server: address)
            guard revision == requestRevision else { return }
            snapshot = result
            lastReceivedAt = Date()
            errorMessage = nil
        } catch {
            guard revision == requestRevision, !Task.isCancelled else { return }
            errorMessage = error is DecodingError
                ? "无法读取服务器数据，请确认地址指向观测所服务。"
                : error.localizedDescription
        }
        await statusRefresh
    }

    private func refreshMobileStatus(address: ServerAddress, requestRevision: UUID) async {
        do {
            let data = try await api.request(url: address.endpoint("api/mobile/status"))
            let result = try JSONDecoder().decode(MobileStatus.self, from: data)
            guard revision == requestRevision else { return }
            mobileStatus = result
            mobileStatusError = nil
        } catch {
            guard revision == requestRevision, !Task.isCancelled else { return }
            mobileStatus = nil
            mobileStatusError = "暂时无法读取通知服务状态。"
        }
    }

    func sendTest() async {
        guard !isTesting, mobileStatus?.testAvailable == true else { return }
        isTesting = true
        testResult = nil
        let requestRevision = revision
        let address = server
        defer { isTesting = false }
        do {
            let secret = try SecureStore.read(server: address)
            guard !secret.isEmpty else {
                testResult = "请先保存服务器对应的测试密钥。"
                return
            }
            _ = try await api.request(url: address.endpoint("api/mobile/test"), method: "POST", secret: secret)
            guard revision == requestRevision else { return }
            testResult = "测试已发送，请在 Telegram 查看消息。"
            await refreshMobileStatus(address: address, requestRevision: requestRevision)
        } catch {
            guard revision == requestRevision, !Task.isCancelled else { return }
            testResult = error.localizedDescription
        }
    }
}
