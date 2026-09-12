import Foundation

struct ServerAddress: Equatable {
    static let defaultValue = "http://allenflux.tech:9090"
    let url: URL

    init(_ input: String) throws {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.port.map({ (1...65535).contains($0) }) ?? true else {
            throw AddressError.invalid
        }
        components.scheme = scheme
        while components.path.hasSuffix("/") { components.path.removeLast() }
        guard let url = components.url else { throw AddressError.invalid }
        self.url = url
    }

    func endpoint(_ path: String) -> URL { url.appendingPathComponent(path) }

    enum AddressError: LocalizedError {
        case invalid
        var errorDescription: String? {
            "请输入完整的 HTTP 或 HTTPS 服务器地址，不要包含账号、查询参数或 #。"
        }
    }
}
