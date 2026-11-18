import ExpoModulesCore
import Foundation

private final class ImportSessionDelegate: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

private enum ImportTransportError: Error {
  case requestFailed
}

public final class ImportTransportModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ImportTransport")

    AsyncFunction("post") { (address: String, token: String, mediaType: String, body: String) async throws -> [String: Any] in
      guard let parts = URLComponents(string: address), let url = parts.url, let host = parts.host,
            !host.isEmpty, parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
            parts.scheme == "https" ||
              (parts.scheme == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(host)) else {
        return ["status": 503, "body": ""]
      }

      // A 307/308 can replay a POST body. Reject redirects before the
      // networking stack sends anything to the second destination.
      let config = URLSessionConfiguration.ephemeral
      config.httpShouldSetCookies = false
      config.requestCachePolicy = .reloadIgnoringLocalCacheData
      config.timeoutIntervalForResource = 55
      let session = URLSession(configuration: config, delegate: ImportSessionDelegate(), delegateQueue: nil)
      defer { session.finishTasksAndInvalidate() }

      var request = URLRequest(url: url)
      request.httpMethod = "POST"
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      request.setValue(mediaType, forHTTPHeaderField: "Content-Type")
      request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
      request.httpBody = Data(body.utf8)
      do {
        let (data, result) = try await session.data(for: request)
        guard let response = result as? HTTPURLResponse else { throw ImportTransportError.requestFailed }
        let status = response.statusCode
        guard (200..<300).contains(status) else { return ["status": status, "body": ""] }
        guard data.count <= 512 * 1024, let json = String(data: data, encoding: .utf8) else {
          throw ImportTransportError.requestFailed
        }
        return ["status": status, "body": json]
      } catch {
        throw ImportTransportError.requestFailed
      }
    }
  }
}
