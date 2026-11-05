import Foundation
import Synchronization
@testable import MixaiCore

/// Records requests and answers from a route table: "METHOD /path" (path without query) → response.
final class StubTransport: HTTPTransport, Sendable {
    private struct State {
        var routes: [String: [HTTPResponse]] = [:]
        var requests: [URLRequest] = []
    }
    private let state = Mutex(State())

    func on(_ method: String, _ path: String, _ responses: HTTPResponse...) {
        state.withLock { $0.routes["\(method) \(path)", default: []].append(contentsOf: responses) }
    }

    func json(_ method: String, _ path: String, status: Int = 200, _ body: String) {
        on(method, path, HTTPResponse(status: status, body: Data(body.utf8)))
    }

    var requests: [URLRequest] { state.withLock { $0.requests } }

    var paths: [String] { requests.map { "\($0.httpMethod ?? "GET") \($0.url?.path ?? "")" } }

    func send(_ request: URLRequest, followRedirects: Bool) async throws -> HTTPResponse {
        state.withLock { s in
            s.requests.append(request)
            let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
            guard var list = s.routes[key], !list.isEmpty else { return HTTPResponse(status: 404, body: Data("no route \(key)".utf8)) }
            let r = list.count > 1 ? list.removeFirst() : list[0]
            s.routes[key] = list
            return r
        }
    }
}

enum Fixture {
    static func data(_ name: String) throws -> Data {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try Data(contentsOf: url)
    }

    static func text(_ name: String) throws -> String { String(decoding: try data(name), as: UTF8.self) }
}

func tempDir() -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("mixai-tests-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}
