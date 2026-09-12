import Foundation
import Security

enum SecureStore {
    private static var service: String {
        (Bundle.main.bundleIdentifier ?? "tech.allenflux.ResetObservatory") + ".mobile-test"
    }

    private static func query(server: ServerAddress) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: server.url.absoluteString]
    }

    static func read(server: ServerAddress) throws -> String {
        var query = query(server: server)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else { throw StorageError.failed }
        return value
    }

    static func save(_ value: String, server: ServerAddress) throws {
        let query = query(server: server)
        if value.isEmpty {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw StorageError.failed }
            return
        }
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let addStatus = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw StorageError.failed }
        } else if status != errSecSuccess { throw StorageError.failed }
    }

    enum StorageError: LocalizedError {
        case failed
        var errorDescription: String? { "无法访问设备钥匙串，请解锁设备后重试。" }
    }
}
