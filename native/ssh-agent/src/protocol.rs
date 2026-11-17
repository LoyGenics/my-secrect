//! SSH agent wire protocol (OpenSSH agent protocol, draft-miller-ssh-agent).
//!
//! This module is REAL, fully implemented framing code: length-prefixed
//! messages, big-endian fields, bounds-checked parsing. It is the only part
//! of the agent that is done. Identity loading and signing are NOT
//! implemented (see `main.rs` / README.md) — this module never touches keys.
//!
//! Message layout on the socket: `u32be length || payload`. Payload starts
//! with a 1-byte message type. Strings are `u32be length || bytes`.

use std::io;

pub const SSH_AGENT_FAILURE: u8 = 5;
pub const SSH_AGENT_SUCCESS: u8 = 6;
pub const SSH_AGENTC_REQUEST_IDENTITIES: u8 = 11;
pub const SSH_AGENT_IDENTITIES_ANSWER: u8 = 12;
pub const SSH_AGENTC_SIGN_REQUEST: u8 = 13;
pub const SSH_AGENT_SIGN_RESPONSE: u8 = 14;

/// Hard cap on one message. Anything larger is a protocol error, never
/// allocated or read. 1 MiB is far above any legitimate agent message.
pub const MAX_MESSAGE_LEN: usize = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum AgentRequest {
    RequestIdentities,
    SignRequest {
        key_blob: Vec<u8>,
        data: Vec<u8>,
        flags: u32,
    },
    Unknown(u8),
}

/// Bounds-checked big-endian reader over one already-framed message.
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    pub fn is_empty(&self) -> bool {
        self.pos == self.buf.len()
    }

    pub fn u8(&mut self) -> io::Result<u8> {
        let b = self.buf.get(self.pos).copied().ok_or_else(|| {
            io::Error::new(io::ErrorKind::UnexpectedEof, "message truncated (u8)")
        })?;
        self.pos += 1;
        Ok(b)
    }

    pub fn u32(&mut self) -> io::Result<u32> {
        let bytes = self.buf.get(self.pos..self.pos + 4).ok_or_else(|| {
            io::Error::new(io::ErrorKind::UnexpectedEof, "message truncated (u32)")
        })?;
        self.pos += 4;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    /// Length-prefixed byte string. The declared length must fit inside
    /// the remaining buffer — a lying length is a protocol error.
    pub fn bytes(&mut self) -> io::Result<&'a [u8]> {
        let len = self.u32()? as usize;
        let bytes = self.buf.get(self.pos..self.pos + len).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "string length exceeds message")
        })?;
        self.pos += len;
        Ok(bytes)
    }
}

/// Parse one framed message payload (without the 4-byte length prefix).
/// Trailing bytes after a complete request are a protocol error.
pub fn parse_request(msg: &[u8]) -> io::Result<AgentRequest> {
    let mut r = Reader::new(msg);
    let req = match r.u8()? {
        SSH_AGENTC_REQUEST_IDENTITIES => AgentRequest::RequestIdentities,
        SSH_AGENTC_SIGN_REQUEST => {
            let key_blob = r.bytes()?.to_vec();
            let data = r.bytes()?.to_vec();
            let flags = r.u32()?;
            AgentRequest::SignRequest { key_blob, data, flags }
        }
        other => AgentRequest::Unknown(other),
    };
    if !r.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "trailing bytes after agent request",
        ));
    }
    Ok(req)
}

/// Wrap a payload in its 4-byte big-endian length prefix.
pub fn frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn push_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn push_string(out: &mut Vec<u8>, s: &[u8]) {
    push_u32(out, s.len() as u32);
    out.extend_from_slice(s);
}

/// SSH_AGENT_IDENTITIES_ANSWER for `keys`: (key blob, comment) pairs.
/// An empty list is a valid answer — it means "no keys loaded", which is
/// the agent's honest state today (see main.rs).
pub fn encode_identities_answer(keys: &[(Vec<u8>, String)]) -> Vec<u8> {
    let mut payload = vec![SSH_AGENT_IDENTITIES_ANSWER];
    push_u32(&mut payload, keys.len() as u32);
    for (blob, comment) in keys {
        push_string(&mut payload, blob);
        push_string(&mut payload, comment.as_bytes());
    }
    frame(&payload)
}

/// SSH_AGENT_FAILURE, framed. Used for every unimplemented / rejected
/// request — including all signing attempts until signing is implemented.
pub fn encode_failure() -> Vec<u8> {
    frame(&[SSH_AGENT_FAILURE])
}

/// SSH_AGENT_SUCCESS, framed. (Reserved for future operations that
/// succeed with no payload, e.g. remove-all-identities once implemented.)
#[allow(dead_code)]
pub fn encode_success() -> Vec<u8> {
    frame(&[SSH_AGENT_SUCCESS])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn framed_request_identities() -> Vec<u8> {
        frame(&[SSH_AGENTC_REQUEST_IDENTITIES])
    }

    #[test]
    fn parse_request_identities() {
        let framed = framed_request_identities();
        assert_eq!(framed, vec![0, 0, 0, 1, SSH_AGENTC_REQUEST_IDENTITIES]);
        assert_eq!(
            parse_request(&framed[4..]).unwrap(),
            AgentRequest::RequestIdentities
        );
    }

    #[test]
    fn parse_sign_request_roundtrip() {
        let mut payload = vec![SSH_AGENTC_SIGN_REQUEST];
        push_string(&mut payload, b"ssh-ed25519-blob");
        push_string(&mut payload, b"data-to-sign");
        push_u32(&mut payload, 2); // SSH_AGENT_RSA_SHA2_256 flag value slot
        let req = parse_request(&payload).unwrap();
        assert_eq!(
            req,
            AgentRequest::SignRequest {
                key_blob: b"ssh-ed25519-blob".to_vec(),
                data: b"data-to-sign".to_vec(),
                flags: 2,
            }
        );
    }

    #[test]
    fn parse_rejects_trailing_bytes_and_lying_lengths() {
        assert!(parse_request(&[SSH_AGENTC_REQUEST_IDENTITIES, 0]).is_err());
        let mut bad = vec![SSH_AGENTC_SIGN_REQUEST];
        push_u32(&mut bad, 9999); // claims 9999 bytes, provides none
        assert!(parse_request(&bad).is_err());
        assert!(parse_request(&[]).is_err());
    }

    #[test]
    fn identities_answer_empty_and_one_key() {
        // Empty answer: type 12, count 0.
        assert_eq!(
            encode_identities_answer(&[]),
            vec![0, 0, 0, 5, SSH_AGENT_IDENTITIES_ANSWER, 0, 0, 0, 0]
        );
        // One key: the blob and comment survive a Reader round-trip.
        let blob = vec![0, 0, 0, 11, b's', b's', b'h', b'-', b'e', b'd', b'2', b'5', b'5', b'1', b'9'];
        let encoded = encode_identities_answer(&[(blob.clone(), "my-secrect".to_string())]);
        let mut r = Reader::new(&encoded[4..]);
        assert_eq!(r.u8().unwrap(), SSH_AGENT_IDENTITIES_ANSWER);
        assert_eq!(r.u32().unwrap(), 1);
        assert_eq!(r.bytes().unwrap(), blob.as_slice());
        assert_eq!(r.bytes().unwrap(), b"my-secrect");
        assert!(r.is_empty());
    }

    #[test]
    fn failure_frame_is_one_byte_payload() {
        assert_eq!(encode_failure(), vec![0, 0, 0, 1, SSH_AGENT_FAILURE]);
    }
}
