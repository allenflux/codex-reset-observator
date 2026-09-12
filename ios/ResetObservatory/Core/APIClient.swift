import Foundation

final class APIClient {
    private let session: URLSession

    init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 30
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    func snapshot(server: ServerAddress) async throws -> ObservatorySnapshot {
        var components = URLComponents(url: server.endpoint("api/current"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "locale", value: "zh")]
        let data = try await request(url: components.url!)
        let snapshot = try JSONDecoder().decode(ObservatorySnapshot.self, from: data)
        guard snapshot.schemaVersion == "public-v1" else { throw APIError.unsupportedSchema }
        return snapshot
    }

    func request(url: URL, method: String = "GET", secret: String? = nil) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if method == "POST" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{}".utf8)
        }
        if let secret, !secret.isEmpty {
            request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else { throw APIError.http(response.statusCode) }
        return data
    }
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    // A server redirect must never forward the private test key to another origin.
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum APIError: LocalizedError {
    case invalidResponse, unsupportedSchema, http(Int)

    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "服务器没有返回有效响应。"
        case .unsupportedSchema: return "服务器数据格式已更新，请更新客户端。"
        case .http(401), .http(403): return "测试密钥不正确，或服务器拒绝了请求。"
        case .http(404): return "服务器尚未提供此接口。"
        case .http(429): return "测试请求过于频繁，请稍后再试。"
        case .http(502): return "Telegram 暂未接受通知，请稍后重试或检查服务器配置。"
        case .http(503): return "服务暂未就绪，请稍后再试。"
        case .http(let status): return "服务器返回错误（\(status)）。"
        }
    }
}
