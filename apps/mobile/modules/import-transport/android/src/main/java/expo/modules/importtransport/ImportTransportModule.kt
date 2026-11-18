package expo.modules.importtransport

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.HttpURLConnection
import java.net.URI

class ImportTransportModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ImportTransport")

    AsyncFunction("post") { address: String, token: String, mediaType: String, body: String ->
      try {
        val uri = URI(address)
        val localHttp = uri.scheme == "http" && uri.host in listOf("localhost", "127.0.0.1", "[::1]")
        if (uri.host.isNullOrEmpty() || (uri.scheme != "https" && !localHttp) ||
          uri.userInfo != null || uri.query != null || uri.fragment != null
        ) {
          return@AsyncFunction mapOf("status" to 503, "body" to "")
        }

        val connection = uri.toURL().openConnection() as HttpURLConnection
        try {
          // Reject 307/308 before the HTTP client can replay the POST body.
          connection.instanceFollowRedirects = false
          connection.useCaches = false
          connection.connectTimeout = 5_000
          connection.readTimeout = 50_000
          connection.requestMethod = "POST"
          connection.doOutput = true
          connection.setRequestProperty("Authorization", "Bearer $token")
          connection.setRequestProperty("Content-Type", mediaType)
          connection.setRequestProperty("Cache-Control", "no-store")
          val bytes = body.toByteArray(Charsets.UTF_8)
          connection.setFixedLengthStreamingMode(bytes.size)
          connection.outputStream.use { it.write(bytes) }
          val status = connection.responseCode
          val response = if (status in 200..299) {
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
              val result = StringBuilder()
              val buffer = CharArray(4096)
              while (true) {
                val read = reader.read(buffer)
                if (read == -1) break
                if (result.length + read > 512 * 1024) error("Import preview too large")
                result.append(buffer, 0, read)
              }
              result.toString()
            }
          } else ""
          mapOf("status" to status, "body" to response)
        } finally {
          connection.disconnect()
        }
      } catch (_: Exception) {
        throw IllegalStateException("AI import request failed")
      }
    }
  }
}
