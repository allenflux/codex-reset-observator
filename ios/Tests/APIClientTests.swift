import Foundation
import XCTest
@testable import ResetCore

final class APIClientTests: XCTestCase {
    private func client(status: Int = 200, body: String = "{}",
                        inspect: @escaping (URLRequest) -> Void) -> APIClient {
        StubURLProtocol.handler = { request in
            inspect(request)
            return (HTTPURLResponse(url: request.url!, statusCode: status,
                                    httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return APIClient(configuration: configuration)
    }

    func testTestNotificationUsesEmptyJSONAndDedicatedBearerKey() async throws {
        let api = client { request in
            XCTAssertEqual(request.url?.path, "/api/mobile/test")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-only-placeholder")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            // URLSession may convert the body to a stream before handing it to a protocol.
            var body = request.httpBody
            if body == nil, let stream = request.httpBodyStream {
                stream.open()
                defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 32)
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count > 0 { body = Data(buffer.prefix(count)) }
            }
            XCTAssertEqual(body, Data("{}".utf8))
        }
        _ = try await api.request(url: URL(string: "http://localhost:9090/api/mobile/test")!,
                                  method: "POST", secret: "test-only-placeholder")
    }

    func testPublicStatusDoesNotSendAuthorization() async throws {
        let api = client { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        }
        _ = try await api.request(url: URL(string: "http://localhost:9090/api/mobile/status")!)
    }

    func testServerErrorDoesNotExposeTheResponseBody() async throws {
        let api = client(status: 502, body: "private upstream details") { _ in }
        do {
            _ = try await api.request(url: URL(string: "http://localhost:9090/api/mobile/test")!, method: "POST")
            XCTFail("Expected the failed response to throw")
        } catch {
            XCTAssertFalse(error.localizedDescription.contains("private upstream details"))
            XCTAssertTrue(error.localizedDescription.contains("Telegram"))
        }
    }
}

private final class StubURLProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (HTTPURLResponse, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let (response, data) = Self.handler?(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
