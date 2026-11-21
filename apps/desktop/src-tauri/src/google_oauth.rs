//! "Continue with Google" for the desktop shell.
//!
//! Google refuses OAuth inside embedded webviews, so the sign-in runs in the
//! user's system browser: OAuth 2.0 for installed apps, Authorization Code +
//! PKCE (S256) with a loopback redirect to `http://127.0.0.1:<random port>`
//! (RFC 8252). The code is exchanged at Google's token endpoint for an ID
//! token, which goes back to the webview; the webview hands it to the API
//! (`POST /v1/auth/oauth/google/session`), which verifies it. Nothing is
//! stored here: no token, no code, no verifier.
//!
//! The API's single-use `nonce` is passed through so the ID token is bound
//! to that sign-in attempt. `state` (random) guards the redirect; the
//! listener answers only one matching redirect and stops after
//! `WAIT_FOR_REDIRECT`.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use url::Url;

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const WAIT_FOR_REDIRECT: Duration = Duration::from_secs(300);

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>My Secret</title>\
<p style=\"font:16px system-ui;margin:3em auto;max-width:28em\">You can close this tab and return to My Secret.</p>";

fn random_b64(len: usize) -> Result<String, String> {
    let mut buf = vec![0u8; len];
    getrandom::fill(&mut buf).map_err(|e| format!("no system randomness: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(url).spawn().map(|_| ()).map_err(|e| format!("could not open the browser: {e}"))
}

fn respond(mut stream: &TcpStream, status: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
}

/// What the redirect carried, from the request line `GET /?code=…&state=… HTTP/1.1`.
#[derive(Debug, PartialEq)]
pub enum Redirect {
    Code(String),
    Denied,
    /// Not the redirect (e.g. `/favicon.ico`) or a wrong `state`.
    Other,
}

pub fn parse_redirect(request_line: &str, expected_state: &str) -> Redirect {
    let Some(target) = request_line.strip_prefix("GET ").and_then(|r| r.split(' ').next()) else {
        return Redirect::Other;
    };
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        return Redirect::Other;
    };
    if url.path() != "/" {
        return Redirect::Other;
    }
    let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    if param("state").as_deref() != Some(expected_state) {
        return Redirect::Other;
    }
    match (param("code"), param("error")) {
        (Some(code), None) if !code.is_empty() => Redirect::Code(code),
        _ => Redirect::Denied,
    }
}

fn wait_for_code(listener: TcpListener, state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + WAIT_FOR_REDIRECT;
    while Instant::now() < deadline {
        let stream = match listener.accept() {
            Ok((s, _)) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut line = String::new();
        if BufReader::new(&stream).read_line(&mut line).is_err() {
            continue;
        }
        match parse_redirect(line.trim_end(), state) {
            Redirect::Code(code) => {
                respond(&stream, "200 OK", DONE_PAGE);
                return Ok(code);
            }
            Redirect::Denied => {
                respond(&stream, "200 OK", DONE_PAGE);
                return Err("cancelled".into());
            }
            Redirect::Other => respond(&stream, "404 Not Found", ""),
        }
    }
    Err("cancelled".into())
}

/// Runs the whole browser round trip and returns Google's ID token.
/// Errors are short strings; `"cancelled"` means the user denied consent or
/// never finished within five minutes.
#[tauri::command]
pub async fn google_sign_in(client_id: String, client_secret: Option<String>, nonce: String) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let redirect_uri = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|e| e.to_string())?.port());
    let verifier = random_b64(32)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_b64(16)?;
    let auth_url = Url::parse_with_params(
        AUTH_ENDPOINT,
        &[
            ("client_id", client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", "openid email profile"),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
            ("nonce", nonce.as_str()),
            ("prompt", "select_account"),
        ],
    )
    .map_err(|e| e.to_string())?;
    open_in_browser(auth_url.as_str())?;

    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(listener, &state))
        .await
        .map_err(|e| e.to_string())??;

    let body = {
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        form.append_pair("grant_type", "authorization_code")
            .append_pair("code", &code)
            .append_pair("code_verifier", &verifier)
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", &redirect_uri);
        // Google's "Desktop app" clients still send their (non-confidential)
        // client secret; omitted when the build has none.
        if let Some(secret) = client_secret.as_deref().filter(|s| !s.is_empty()) {
            form.append_pair("client_secret", secret);
        }
        form.finish()
    };
    let res = reqwest::Client::new()
        .post(TOKEN_ENDPOINT)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("token exchange failed: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| format!("token exchange failed: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    match json.get("id_token").and_then(|v| v.as_str()) {
        Some(id_token) if status.is_success() => Ok(id_token.to_string()),
        _ => Err(format!("token exchange failed: HTTP {status}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_with_matching_state_yields_the_code() {
        assert_eq!(parse_redirect("GET /?state=abc&code=4%2F0Ax HTTP/1.1", "abc"), Redirect::Code("4/0Ax".into()));
    }

    #[test]
    fn denied_consent_is_reported() {
        assert_eq!(parse_redirect("GET /?error=access_denied&state=abc HTTP/1.1", "abc"), Redirect::Denied);
    }

    #[test]
    fn wrong_state_or_other_paths_are_ignored() {
        assert_eq!(parse_redirect("GET /?state=evil&code=x HTTP/1.1", "abc"), Redirect::Other);
        assert_eq!(parse_redirect("GET /favicon.ico HTTP/1.1", "abc"), Redirect::Other);
        assert_eq!(parse_redirect("POST /?state=abc&code=x HTTP/1.1", "abc"), Redirect::Other);
    }
}
