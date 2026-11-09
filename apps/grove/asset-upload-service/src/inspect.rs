//! What an upload must be before it is copied where the CDN reads: its declared length, and the
//! first bytes of its declared type. The bucket is reached only through a claim's presigned URLs.

use std::time::Duration;

use anyhow::{anyhow, bail, Context as _, Result};
use reqwest::header::CONTENT_TYPE;
use reqwest::StatusCode;

/// One transfer of at most the asset ceiling; the presigned URLs it uses outlive it several times.
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(60);

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Where a settle message stops, which is what a creator's asset panel has room for.
pub const MAX_MESSAGE_CHARS: usize = 200;

/// The bucket as a worker needs it: one read of the quarantined bytes and one write of the copy.
#[async_trait::async_trait]
pub trait Bucket: Send + Sync {
    /// The object behind `url`, read no further than `limit` bytes, or `None` when it is gone.
    async fn fetch(&self, url: &str, limit: u64) -> Result<Option<Vec<u8>>>;
    /// Writes `bytes` to `url` as `content_type`, answering the version the bucket gave the copy.
    async fn publish(&self, url: &str, content_type: &str, bytes: Vec<u8>) -> Result<String>;
}

pub struct HttpBucket {
    client: reqwest::Client,
}

impl HttpBucket {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(TRANSFER_TIMEOUT)
                .connect_timeout(CONNECT_TIMEOUT)
                .build()
                .context("building the bucket client")?,
        })
    }
}

#[async_trait::async_trait]
impl Bucket for HttpBucket {
    async fn fetch(&self, url: &str, limit: u64) -> Result<Option<Vec<u8>>> {
        let mut response = self
            .client
            .get(url)
            .send()
            .await
            .context("reading an upload")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            bail!("the bucket answered {} for an upload", response.status());
        }

        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.context("reading an upload")? {
            bytes.extend_from_slice(&chunk);
            // Past the limit is already the verdict, so the rest of a body never has to be held.
            if bytes.len() >= limit {
                bytes.truncate(limit);
                break;
            }
        }
        Ok(Some(bytes))
    }

    async fn publish(&self, url: &str, content_type: &str, bytes: Vec<u8>) -> Result<String> {
        let response = self
            .client
            .put(url)
            .header(CONTENT_TYPE, content_type)
            .body(bytes)
            .send()
            .await
            .context("copying an asset")?;
        if !response.status().is_success() {
            bail!(
                "the bucket answered {} for an asset copy",
                response.status()
            );
        }
        response
            .headers()
            .get("x-amz-version-id")
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("the bucket kept no version of the copy; is versioning on?"))
    }
}

/// Why an upload is not an asset, in words its creator can act on.
#[derive(Debug, PartialEq, Eq)]
pub struct Invalid(pub String);

/// Holds `bytes` to the length and type an upload was declared with.
pub fn check(content_type: &str, declared: u64, bytes: &[u8]) -> Result<(), Invalid> {
    let length = bytes.len() as u64;
    if length > declared {
        return Err(Invalid(format!(
            "this upload is longer than the {declared} bytes it was declared as"
        )));
    }
    if length < declared {
        return Err(Invalid(format!(
            "this upload is {length} bytes, not the {declared} it was declared as"
        )));
    }

    let Some((kind, starts_right)) = signature(content_type) else {
        return Err(Invalid(format!(
            "{content_type} is not a type an asset may be"
        )));
    };
    if starts_right(bytes) {
        Ok(())
    } else {
        Err(Invalid(format!("this upload is not {kind}")))
    }
}

/// What a type is called to a creator, and the test its first bytes have to pass.
type Signature = (&'static str, fn(&[u8]) -> bool);

fn signature(content_type: &str) -> Option<Signature> {
    let entry: Signature = match content_type {
        "image/png" => ("a PNG image", |b| b.starts_with(b"\x89PNG\r\n\x1a\n")),
        "image/jpeg" => ("a JPEG image", |b| b.starts_with(&[0xFF, 0xD8, 0xFF])),
        "image/gif" => ("a GIF image", |b| {
            b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a")
        }),
        "image/webp" => ("a WebP image", |b| riff(b, b"WEBP")),
        // An ID3 tag, or the eleven set bits every MPEG audio frame opens with.
        "audio/mpeg" => ("an MP3 file", |b| {
            b.starts_with(b"ID3") || matches!(b, [0xFF, second, ..] if second & 0xE0 == 0xE0)
        }),
        "audio/ogg" => ("an Ogg file", |b| b.starts_with(b"OggS")),
        "audio/wav" => ("a WAV file", |b| riff(b, b"WAVE")),
        "audio/webm" => ("a WebM file", |b| b.starts_with(&[0x1A, 0x45, 0xDF, 0xA3])),
        "font/woff2" => ("a WOFF2 font", |b| b.starts_with(b"wOF2")),
        "font/woff" => ("a WOFF font", |b| b.starts_with(b"wOFF")),
        "font/ttf" => ("a TrueType font", |b| {
            b.starts_with(&[0x00, 0x01, 0x00, 0x00]) || b.starts_with(b"true")
        }),
        "font/otf" => ("an OpenType font", |b| b.starts_with(b"OTTO")),
        // Parsed whole and kept as nothing, so a document is checked without building its tree.
        "application/json" => ("JSON", |b| {
            std::str::from_utf8(b)
                .is_ok_and(|text| serde_json::from_str::<serde::de::IgnoredAny>(text).is_ok())
        }),
        _ => return None,
    };
    Some(entry)
}

/// A RIFF container of `form`: the tag, a length, then the form type.
fn riff(bytes: &[u8], form: &[u8; 4]) -> bool {
    bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == form
}

/// Cut to what a settle carries, at a character boundary.
pub fn clipped(message: &str) -> String {
    message.chars().take(MAX_MESSAGE_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread::JoinHandle;

    /// A first few bytes of each type, as a tool that writes one would start the file.
    const GOOD: &[(&str, &[u8])] = &[
        ("image/png", b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"),
        ("image/jpeg", &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10]),
        ("image/gif", b"GIF89a\x01\0\x01\0"),
        ("image/gif", b"GIF87a\x01\0\x01\0"),
        ("image/webp", b"RIFF\x24\0\0\0WEBPVP8 "),
        ("audio/mpeg", b"ID3\x04\0\0\0\0\0\0"),
        ("audio/mpeg", &[0xFF, 0xFB, 0x90, 0x64]),
        ("audio/ogg", b"OggS\0\x02\0\0"),
        ("audio/wav", b"RIFF\x24\0\0\0WAVEfmt "),
        ("audio/webm", &[0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42]),
        ("font/woff2", b"wOF2\0\x01\0\0"),
        ("font/woff", b"wOFF\0\x01\0\0"),
        ("font/ttf", &[0x00, 0x01, 0x00, 0x00, 0x00, 0x0A]),
        ("font/ttf", b"true\0\x0A\0\x80"),
        ("font/otf", b"OTTO\0\x0A\0\x80"),
        ("application/json", br#"{"frames":[1,2,3],"name":"leaf"}"#),
    ];

    fn checked(content_type: &str, bytes: &[u8]) -> Result<(), Invalid> {
        check(content_type, bytes.len() as u64, bytes)
    }

    #[test]
    fn passes_every_type_that_starts_the_way_it_says() {
        for (content_type, bytes) in GOOD {
            assert_eq!(checked(content_type, bytes), Ok(()), "{content_type}");
        }
    }

    /// Each type's bytes under every other type's name, which is the rename a quarantine exists for.
    #[test]
    fn refuses_bytes_declared_as_a_type_they_are_not() {
        for (declared, _) in GOOD {
            for (actual, bytes) in GOOD {
                if declared != actual {
                    assert!(
                        checked(declared, bytes).is_err(),
                        "{actual} passed as {declared}"
                    );
                }
            }
        }
    }

    #[test]
    fn refuses_a_riff_of_the_wrong_form() {
        assert!(checked("image/webp", b"RIFF\x24\0\0\0WAVEfmt ").is_err());
        assert!(checked("audio/wav", b"RIFF").is_err());
    }

    #[test]
    fn refuses_json_that_does_not_parse_or_is_not_utf8() {
        assert!(checked("application/json", br#"{"frames":[1,2"#).is_err());
        assert!(checked("application/json", b"{\"name\":\"\xff\"}").is_err());
        assert!(checked("application/json", b"\xef\xbb\xbf{}").is_err());
    }

    #[test]
    fn refuses_an_upload_of_any_length_but_the_declared_one() {
        let png = GOOD[0].1;

        assert_eq!(
            check("image/png", png.len() as u64 + 1, png),
            Err(Invalid(format!(
                "this upload is {} bytes, not the {} it was declared as",
                png.len(),
                png.len() + 1
            )))
        );
        assert!(check("image/png", png.len() as u64 - 1, png)
            .unwrap_err()
            .0
            .contains("longer than"));
    }

    #[test]
    fn refuses_a_type_outside_the_ones_an_asset_may_be() {
        assert!(checked("text/html", b"<html>").is_err());
    }

    #[test]
    fn clips_a_message_to_what_a_settle_carries_without_splitting_a_character() {
        let long = "é".repeat(MAX_MESSAGE_CHARS + 10);

        assert_eq!(clipped(&long).chars().count(), MAX_MESSAGE_CHARS);
        assert_eq!(clipped("short"), "short");
    }

    /// A stand-in for the bucket: answers one call and hands back everything it was sent.
    fn one_call(answer: Vec<u8>) -> (String, JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_millis(500)))
                .unwrap();
            let mut seen = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                match socket.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => seen.extend_from_slice(&chunk[..read]),
                }
                let text = String::from_utf8_lossy(&seen).to_lowercase();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .map_or(0, |value| value.trim().parse::<usize>().unwrap());
                    if seen.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            socket.write_all(&answer).unwrap();
            seen
        });
        (base, handle)
    }

    fn reply(head: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!("{head}\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        out.extend_from_slice(body);
        out
    }

    #[tokio::test]
    async fn reads_an_upload_no_further_than_the_limit() {
        let (base, bucket) = one_call(reply("HTTP/1.1 200 OK", &[7u8; 64]));

        let read = HttpBucket::new()
            .unwrap()
            .fetch(&format!("{base}/uploads/leaf.png"), 10)
            .await
            .unwrap();

        assert_eq!(read, Some(vec![7u8; 10]));
        assert!(
            String::from_utf8_lossy(&bucket.join().unwrap()).starts_with("GET /uploads/leaf.png")
        );
    }

    #[tokio::test]
    async fn reads_an_upload_the_bucket_no_longer_holds_as_gone() {
        let (base, _bucket) = one_call(reply("HTTP/1.1 404 Not Found", b""));

        let read = HttpBucket::new().unwrap().fetch(&base, 10).await.unwrap();

        assert_eq!(read, None);
    }

    /// A presign that lapsed or a bucket that failed is the fleet's, so it is an error to retry.
    #[tokio::test]
    async fn a_refused_read_is_an_error_rather_than_a_verdict() {
        let (base, _bucket) = one_call(reply("HTTP/1.1 403 Forbidden", b""));

        assert!(HttpBucket::new().unwrap().fetch(&base, 10).await.is_err());
    }

    #[tokio::test]
    async fn copies_with_the_signed_type_and_answers_the_version_it_made() {
        let (base, bucket) = one_call(reply(
            "HTTP/1.1 200 OK\r\nx-amz-version-id: 3HL4kqtJlcpXroDT",
            b"",
        ));

        let version = HttpBucket::new()
            .unwrap()
            .publish(
                &format!("{base}/assets/leaf.png"),
                "image/png",
                b"\x89PNG".to_vec(),
            )
            .await
            .unwrap();

        assert_eq!(version, "3HL4kqtJlcpXroDT");
        let sent = String::from_utf8_lossy(&bucket.join().unwrap()).to_lowercase();
        assert!(sent.starts_with("put /assets/leaf.png"), "{sent}");
        assert!(sent.contains("content-type: image/png"), "{sent}");
        assert!(sent.ends_with("\u{fffd}png"), "{sent}");
    }

    #[tokio::test]
    async fn a_copy_the_bucket_kept_no_version_of_is_an_error() {
        let (base, _bucket) = one_call(reply("HTTP/1.1 200 OK", b""));

        let copied = HttpBucket::new()
            .unwrap()
            .publish(&base, "image/png", b"\x89PNG".to_vec())
            .await;

        assert!(copied.is_err());
    }
}
