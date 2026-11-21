//! One fake HTTP peer for every suite in this workspace, on blocking std so it needs no tokio
//! feature the crates do not already carry.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread::JoinHandle;
use std::time::Duration;

/// How long the fake waits on a caller that went quiet before it answers anyway.
const READ_GRACE: Duration = Duration::from_millis(500);

/// A loopback server that answers exactly one call with fixed bytes.
pub struct OneCall {
    /// `http://127.0.0.1:<port>`, with no trailing slash.
    pub base: String,
    handle: JoinHandle<Vec<u8>>,
}

impl OneCall {
    /// Answers the first call with `answer`, written verbatim once the request's head and body are in.
    pub fn answering(answer: impl Into<Vec<u8>>) -> Self {
        let answer = answer.into();
        let listener = TcpListener::bind("127.0.0.1:0").expect("binding a loopback port");
        let base = format!("http://{}", listener.local_addr().expect("the bound port"));
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("a call from the crate under test");
            socket
                .set_read_timeout(Some(READ_GRACE))
                .expect("a read timeout");
            let mut seen = Vec::new();
            let mut chunk = [0_u8; 4096];
            while !whole(&seen) {
                match socket.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => seen.extend_from_slice(&chunk[..read]),
                }
            }
            socket.write_all(&answer).expect("answering");
            seen
        });
        Self { base, handle }
    }

    /// Answers with a status line, `headers` (each `Name: value`) and `body`, sized for the caller.
    pub fn replying(status: &str, headers: &[&str], body: impl AsRef<[u8]>) -> Self {
        let body = body.as_ref();
        let mut head = format!("HTTP/1.1 {status}\r\n");
        for header in headers {
            head.push_str(header);
            head.push_str("\r\n");
        }
        head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
        let mut answer = head.into_bytes();
        answer.extend_from_slice(body);
        Self::answering(answer)
    }

    /// Everything the caller sent, head and body, once the call has been answered.
    pub fn received(self) -> Vec<u8> {
        self.handle.join().expect("the fake server thread")
    }

    /// What the caller sent, as text, for a suite that matches on a header or the body.
    pub fn received_text(self) -> String {
        String::from_utf8_lossy(&self.received()).into_owned()
    }
}

/// Whether `seen` holds a request head and as much body as that head declared.
fn whole(seen: &[u8]) -> bool {
    let Some(end) = seen.windows(4).position(|four| four == b"\r\n\r\n") else {
        return false;
    };
    let head = String::from_utf8_lossy(&seen[..end]).to_lowercase();
    let length = head
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    seen.len() >= end + 4 + length
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;

    #[test]
    fn hands_back_the_head_and_the_body_it_was_sent() {
        let server = OneCall::replying("200 OK", &["X-Seen: yes"], "done");
        let mut caller = TcpStream::connect(server.base.trim_start_matches("http://")).unwrap();
        caller
            .write_all(b"PUT /thing HTTP/1.1\r\nContent-Length: 4\r\n\r\nbody")
            .unwrap();
        let mut answer = String::new();
        caller.read_to_string(&mut answer).unwrap();

        assert!(answer.starts_with("HTTP/1.1 200 OK\r\nX-Seen: yes\r\n"));
        assert!(answer.ends_with("\r\n\r\ndone"));
        assert!(server.received_text().ends_with("\r\n\r\nbody"));
    }
}
