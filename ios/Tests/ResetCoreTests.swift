import XCTest
@testable import ResetCore

final class ResetCoreTests: XCTestCase {
    func testHTTPServerPreservesPortAndReverseProxyPrefix() throws {
        let server = try ServerAddress("  http://192.168.1.20:9090/observatory/  ")
        XCTAssertEqual(server.endpoint("api/current").absoluteString,
                       "http://192.168.1.20:9090/observatory/api/current")
        XCTAssertEqual(try ServerAddress(ServerAddress.defaultValue).url.scheme, "http")
    }

    func testRejectsCredentialsQueriesAndNonHTTPServerAddresses() {
        let rejected = ["", "allenflux.tech:9090", "file:///tmp/data", "javascript:alert(1)",
                        "https://user:secret@example.com", "https://example.com?token=secret",
                        "https://example.com/#fragment", "http://example.com:0", "http://example.com:65536"]
        for value in rejected { XCTAssertThrowsError(try ServerAddress(value), value) }
    }

    func testPublicSnapshotDecodesMissingOptionalFieldsAndKeepsReferenceDistinct() throws {
        let data = Data("""
        {"schemaVersion":"public-v1","checkedAt":"2026-09-12T12:30:00.123Z",
         "updatedAt":null,"lastRandomResetAt":null,"dataHealth":{"overall":"degraded","stale":true},
         "viewModel":{"probability24h":0.245,"probability48h":null,
           "activeWindow":{"active":true,"kind":"official","timingUnresolved":true},
           "recentHistory":[{"key":"event-1","title":"参考","recordKind":"reference",
             "resetAt":null,"date":"2026-09-10T10:00:00+00:00","source":"javascript:alert(1)"}]},
         "privateFieldIgnored":"unused"}
        """.utf8)
        let snapshot = try JSONDecoder().decode(ObservatorySnapshot.self, from: data)
        XCTAssertTrue(snapshot.viewModel.hasOfficialNotice)
        XCTAssertTrue(snapshot.dataHealth.stale)
        XCTAssertEqual(snapshot.viewModel.recentHistory.first?.id, "event-1")
        XCTAssertEqual(snapshot.viewModel.recentHistory.first?.kindLabel, "参考记录")
        XCTAssertNotNil(snapshot.viewModel.recentHistory.first?.timestamp)
        XCTAssertNil(DisplayFormat.safeLink(snapshot.viewModel.recentHistory.first?.source))
        XCTAssertEqual(DisplayFormat.percent(snapshot.viewModel.probability24h), "25%")
        XCTAssertEqual(DisplayFormat.percent(snapshot.viewModel.probability48h), "—")
    }

    func testRegularWindowDoesNotClaimAnOfficialNotice() throws {
        let data = Data("""
        {"activeWindow":{"active":true,"kind":"regular"},"recentHistory":[]}
        """.utf8)
        XCTAssertFalse(try JSONDecoder().decode(ObservatoryViewModel.self, from: data).hasOfficialNotice)
    }

    func testLegacyNullMissingAndUnknownRecordKindsRemainReferenceRecords() throws {
        let data = Data("""
        [{"title":"旧记录","recordKind":null},
         {"title":"无类型记录"},
         {"title":"未来类型","recordKind":"future_kind"}]
        """.utf8)
        let records = try JSONDecoder().decode([ResetRecord].self, from: data)
        XCTAssertEqual(records.count, 3)
        XCTAssertTrue(records.allSatisfy { $0.recordKind == "reference" && $0.kindLabel == "参考记录" })
    }

    func testPercentNeverPresentsInvalidDataAsARealForecast() {
        for invalid in [Double.nan, Double.infinity, -0.01, 1.01] {
            XCTAssertEqual(DisplayFormat.percent(invalid), "—")
        }
        XCTAssertEqual(DisplayFormat.percent(0), "0%")
        XCTAssertEqual(DisplayFormat.percent(1), "100%")
    }

    func testDateAcceptsBothPublicAPITimestampFormats() {
        XCTAssertNotNil(DisplayFormat.date("2026-09-12T12:30:00Z"))
        XCTAssertNotNil(DisplayFormat.date("2026-09-12T12:30:00.123456+00:00"))
        XCTAssertNil(DisplayFormat.date("not-a-date"))
    }

    func testTelegramStatusContractAllowsNoDeliveryYet() throws {
        let data = Data("""
        {"provider":"telegram","configured":true,"enabled":true,"testAvailable":true,
         "historyIntervalSeconds":60,"pollIntervalSeconds":15,"lastCheckedAt":null,
         "lastSentAt":null,"pendingCount":0,"workerFresh":false,"failedCount":2,
         "lastError":"telegram_delivery_failed"}
        """.utf8)
        let status = try JSONDecoder().decode(MobileStatus.self, from: data)
        XCTAssertEqual(status.provider, "telegram")
        XCTAssertTrue(status.testAvailable)
        XCTAssertNil(status.lastSentAt)
        XCTAssertEqual(status.workerFresh, false)
        XCTAssertEqual(status.failedCount, 2)
        XCTAssertEqual(status.lastError, "telegram_delivery_failed")
    }
}
