import Foundation

/// Raw HTTP answer (status, headers, body) — redirects are NOT followed when asked not to.
public struct HTTPResponse: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: Data

    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status
        self.headers = headers
        self.body = body
    }

    public func header(_ name: String) -> String? {
        headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }

    public var text: String { String(decoding: body, as: UTF8.self) }
}

/// Seam for tests: the app uses [URLSessionTransport], unit tests a stub.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest, followRedirects: Bool) async throws -> HTTPResponse
}

public final class URLSessionTransport: HTTPTransport {
    public static let shared = URLSessionTransport()

    private let session: URLSession
    private let noRedirect: URLSession

    public init(timeout: TimeInterval = 20) {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = timeout
        cfg.waitsForConnectivity = false
        cfg.httpAdditionalHeaders = ["User-Agent": ClientIdentity.current.userAgent]
        session = URLSession(configuration: cfg)
        noRedirect = URLSession(configuration: cfg, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    public func send(_ request: URLRequest, followRedirects: Bool) async throws -> HTTPResponse {
        let (data, response) = try await (followRedirects ? session : noRedirect).data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
            if let key = k as? String { headers[key] = "\(v)" }
        }
        return HTTPResponse(status: http.statusCode, headers: headers, body: data)
    }
}

/// Returns the 3xx itself instead of following it (Live TV stream resolution).
final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}
