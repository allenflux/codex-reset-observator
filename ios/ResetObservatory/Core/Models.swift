import Foundation

struct ObservatorySnapshot: Decodable {
    let schemaVersion: String
    let checkedAt: String?
    let updatedAt: String?
    let lastRandomResetAt: String?
    let dataHealth: DataHealth
    let viewModel: ObservatoryViewModel
    let latestTiboActivity: Activity?
}

struct DataHealth: Decodable {
    let overall: String
    let stale: Bool
}

struct ObservatoryViewModel: Decodable {
    let status: String?
    let probability24h: Double?
    let probability48h: Double?
    let displayReasoningSummary: String?
    let codexOperationalStatus: String?
    let activeWindow: ResetWindow?
    let regularResetForecast: RegularForecast?
    let recentHistory: [ResetRecord]
    let primaryForecast: PrimaryForecast?

    var hasOfficialNotice: Bool {
        activeWindow?.kind == "official" && activeWindow?.active == true
    }
}

struct PrimaryForecast: Decodable {
    let kind: String
    let experimental: Bool?
    let includesAnnouncement: Bool?
}

struct ResetWindow: Decodable {
    let active: Bool
    let kind: String
    let label: String?
    let summary: String?
    let expectedAt: String?
    let expectedEndAt: String?
    let source: String?
    let timingText: String?
    let timingUnresolved: Bool?
    let isOverduePending: Bool?
}

struct RegularForecast: Decodable {
    let expectedAt: String?
    let remaining: String?
}

struct ResetRecord: Decodable, Identifiable {
    let key: String?
    let title: String
    private let recordKindValue: String?
    let resetAt: String?
    let date: String?
    let summary: String?
    let scope: String?
    let source: String?

    enum CodingKeys: String, CodingKey {
        case key, title, resetAt, date, summary, scope, source
        case recordKindValue = "recordKind"
    }

    var recordKind: String {
        guard let value = recordKindValue,
              ["confirmed_global", "banked_distribution", "regular_completed", "reference"].contains(value)
        else { return "reference" }
        return value
    }

    var id: String { key ?? "\(recordKind)|\(resetAt ?? date ?? "")|\(title)" }
    var timestamp: Date? { DisplayFormat.date(resetAt ?? date) }
    var kindLabel: String {
        switch recordKind {
        case "confirmed_global": return "全局重置"
        case "banked_distribution": return "Banked Reset"
        case "regular_completed": return "定期重置"
        default: return "参考记录"
        }
    }
}

struct Activity: Decodable {
    let text: String?
    let createdAt: String?
    let sourceUrl: String?
}

struct MobileStatus: Decodable {
    let provider: String
    let configured: Bool
    let enabled: Bool
    let testAvailable: Bool
    let historyIntervalSeconds: Int
    let pollIntervalSeconds: Int
    let lastCheckedAt: String?
    let lastSentAt: String?
    let pendingCount: Int
    let reason: String?
    let workerFresh: Bool?
    let failedCount: Int?
    let lastError: String?
}

enum DisplayFormat {
    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    static func percent(_ value: Double?) -> String {
        guard let value, value.isFinite, (0...1).contains(value) else { return "—" }
        return "\(Int((value * 100).rounded()))%"
    }

    static func safeLink(_ value: String?) -> URL? {
        guard let value, let url = URL(string: value),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }
}
