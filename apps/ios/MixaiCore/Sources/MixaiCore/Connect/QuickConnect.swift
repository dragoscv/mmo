import Foundation

/// Quick Connect pairing state (`POST /pair/request` → poll `/pair/poll` until approved/expired).
public enum PairState: Sendable, Equatable {
    case idle
    case requesting
    /// Show `code` to the user; approve on the server or in mixai.ro.
    case waiting(code: String, expiresAtMs: Int)
    case approved(deviceToken: String, userId: String?)
    case expired
    case failed(String)

    public var isTerminal: Bool {
        switch self {
        case .approved, .expired, .failed: true
        default: false
        }
    }
}

/// Pure transition function (unit-tested): what a poll answer does to the current state.
public enum PairMachine {
    public static func onRequest(_ r: PairRequestResponse) -> PairState {
        .waiting(code: r.code, expiresAtMs: r.expiresAt)
    }

    public static func onPoll(_ state: PairState, _ poll: PairPollResponse, nowMs: Int) -> PairState {
        guard case .waiting(_, let exp) = state else { return state }
        switch poll.status {
        case .approved:
            guard let tok = poll.deviceToken, !tok.isEmpty else { return .failed("approved without token") }
            return .approved(deviceToken: tok, userId: poll.userId)
        case .expired:
            return .expired
        case .pending, .unknown:
            return nowMs >= exp ? .expired : state
        }
    }

    /// HTTP 404/410 on poll = the code is gone (server restart / expiry).
    public static func onPollError(_ state: PairState, status: Int) -> PairState {
        guard case .waiting = state else { return state }
        return status == 404 || status == 410 ? .expired : state
    }
}

/// Drives the pairing against one server; emits every state change.
public struct QuickConnect: Sendable {
    public let baseURL: String
    public let transport: any HTTPTransport
    public var pollInterval: Duration = .seconds(2)

    public init(baseURL: String, transport: any HTTPTransport = URLSessionTransport.shared) {
        self.baseURL = MmoClient.normalise(baseURL)
        self.transport = transport
    }

    public func run(deviceName: String) -> AsyncStream<PairState> {
        AsyncStream { cont in
            let task = Task {
                let client = MmoClient(baseURL: baseURL, token: "", transport: transport)
                cont.yield(.requesting)
                var state: PairState
                do {
                    let body = try JSON.encoder.encode(PairRequest(deviceName: deviceName, platform: ClientIdentity.current.platform))
                    let data = try await client.request("POST", "/pair/request", body: body, auth: false)
                    let req = try JSON.decoder.decode(PairRequestResponse.self, from: data)
                    state = PairMachine.onRequest(req)
                    cont.yield(state)
                    while !Task.isCancelled, !state.isTerminal {
                        try await Task.sleep(for: pollInterval)
                        let path = "/pair/poll?code=\(MmoClient.enc(req.code))&secret=\(MmoClient.enc(req.secret))"
                        let next: PairState
                        do {
                            let poll = try await client.get(PairPollResponse.self, path, auth: false)
                            next = PairMachine.onPoll(state, poll, nowMs: Int(Date().timeIntervalSince1970 * 1000))
                        } catch let e as APIStatusError {
                            next = PairMachine.onPollError(state, status: e.status)
                        } catch is CancellationError {
                            break
                        } catch {
                            next = state // transient network error: keep polling
                        }
                        if next != state { state = next; cont.yield(state) }
                    }
                } catch is CancellationError {
                } catch {
                    cont.yield(.failed(error.localizedDescription))
                }
                cont.finish()
            }
            cont.onTermination = { _ in task.cancel() }
        }
    }
}
