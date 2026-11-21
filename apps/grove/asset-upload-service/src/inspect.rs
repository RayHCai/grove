//! What an upload must be before the CDN may serve it: its declared length, type and, for an image,
//! a size a player can decode; the bucket is reached only through a claim's presigned URLs.

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
    if !starts_right(bytes) {
        return Err(Invalid(format!("this upload is not {kind}")));
    }
    let Some(measure) = dimensions(content_type) else {
        return Ok(());
    };
    match measure(bytes) {
        Ok((width, height)) => bounded(width, height),
        Err(Header::Cut) => Err(Invalid(format!(
            "this upload ends before the header of {kind} does"
        ))),
        Err(Header::Malformed) => Err(Invalid(format!(
            "this upload starts like {kind} but its header is not one"
        ))),
    }
}

/// The widest side an image may have: the largest texture a WebGL device grants, so nothing wider draws.
pub const MAX_IMAGE_SIDE: u32 = 16_384;

/// Pixels an image may hold, 8192 squared: 256 MiB decoded to RGBA, the most one asset may cost a tab.
pub const MAX_IMAGE_PIXELS: u64 = 8_192 * 8_192;

/// Why an image's dimensions could not be read off its header.
#[derive(Debug, PartialEq, Eq)]
enum Header {
    /// The bytes stop inside the header.
    Cut,
    /// The bytes say something no encoder of the type would write there.
    Malformed,
}

type Measure = fn(&[u8]) -> Result<(u32, u32), Header>;

/// The header reader for an image type, which is what bounds what decoding it will cost.
fn dimensions(content_type: &str) -> Option<Measure> {
    Some(match content_type {
        "image/png" => png_size,
        "image/gif" => gif_size,
        "image/jpeg" => jpeg_size,
        "image/webp" => webp_size,
        _ => return None,
    })
}

fn bounded(width: u32, height: u32) -> Result<(), Invalid> {
    if width == 0 || height == 0 {
        return Err(Invalid(format!(
            "this image is {width}×{height}, which has nothing to draw"
        )));
    }
    if width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE {
        return Err(Invalid(format!(
            "this image is {width}×{height}; an asset may be at most {MAX_IMAGE_SIDE} pixels a side"
        )));
    }
    if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err(Invalid(format!(
            "this image is {width}×{height}; an asset may hold at most {MAX_IMAGE_PIXELS} pixels"
        )));
    }
    Ok(())
}

/// `len` bytes at `at`, or `Cut` where the upload stops first.
fn field(bytes: &[u8], at: usize, len: usize) -> Result<&[u8], Header> {
    bytes.get(at..at + len).ok_or(Header::Cut)
}

fn byte(bytes: &[u8], at: usize) -> Result<u8, Header> {
    bytes.get(at).copied().ok_or(Header::Cut)
}

fn be16(bytes: &[u8], at: usize) -> Result<u32, Header> {
    let b = field(bytes, at, 2)?;
    Ok(u32::from(b[0]) << 8 | u32::from(b[1]))
}

fn le16(bytes: &[u8], at: usize) -> Result<u32, Header> {
    let b = field(bytes, at, 2)?;
    Ok(u32::from(b[1]) << 8 | u32::from(b[0]))
}

fn le24(bytes: &[u8], at: usize) -> Result<u32, Header> {
    let b = field(bytes, at, 3)?;
    Ok(u32::from(b[2]) << 16 | u32::from(b[1]) << 8 | u32::from(b[0]))
}

/// IHDR, which the format requires to be the first chunk after the signature.
fn png_size(bytes: &[u8]) -> Result<(u32, u32), Header> {
    if field(bytes, 8, 8)? != b"\0\0\0\rIHDR" {
        return Err(Header::Malformed);
    }
    let ihdr = field(bytes, 16, 8)?;
    let word = |at: usize| u32::from_be_bytes([ihdr[at], ihdr[at + 1], ihdr[at + 2], ihdr[at + 3]]);
    Ok((word(0), word(4)))
}

/// The logical screen, which every frame of the image is drawn inside.
fn gif_size(bytes: &[u8]) -> Result<(u32, u32), Header> {
    Ok((le16(bytes, 6)?, le16(bytes, 8)?))
}

/// The first start-of-frame segment, walked to past whatever segments precede it.
fn jpeg_size(bytes: &[u8]) -> Result<(u32, u32), Header> {
    let mut at = 2;
    loop {
        if byte(bytes, at)? != 0xFF {
            return Err(Header::Malformed);
        }
        // Any number of fill bytes may stand before a marker.
        while byte(bytes, at)? == 0xFF {
            at += 1;
        }
        let marker = byte(bytes, at)?;
        at += 1;
        match marker {
            // Markers that stand alone, with no length after them.
            0x01 | 0xD0..=0xD8 => continue,
            // A scan or the end with no frame before it is an image with no size to draw at.
            0xD9 | 0xDA => return Err(Header::Malformed),
            // Every start-of-frame but the three codes the standard gave to other segments.
            0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                return Ok((be16(bytes, at + 5)?, be16(bytes, at + 3)?));
            }
            _ => {
                let length = be16(bytes, at)? as usize;
                if length < 2 {
                    return Err(Header::Malformed);
                }
                at += length;
            }
        }
    }
}

/// The first chunk, in whichever of the three encodings it is.
fn webp_size(bytes: &[u8]) -> Result<(u32, u32), Header> {
    match field(bytes, 12, 4)? {
        b"VP8 " => {
            // Lossy: a three-byte frame tag, the key frame's start code, then two 14-bit sides.
            if field(bytes, 23, 3)? != [0x9D, 0x01, 0x2A] {
                return Err(Header::Malformed);
            }
            Ok((le16(bytes, 26)? & 0x3FFF, le16(bytes, 28)? & 0x3FFF))
        }
        b"VP8L" => {
            // Lossless: a signature byte, then each side less one in 14 bits.
            if field(bytes, 20, 1)? != [0x2F] {
                return Err(Header::Malformed);
            }
            let b = field(bytes, 21, 4)?;
            let bits = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            Ok(((bits & 0x3FFF) + 1, (bits >> 14 & 0x3FFF) + 1))
        }
        // Extended: flags and reserved bytes, then the canvas, each side less one in 24 bits.
        b"VP8X" => Ok((le24(bytes, 24)? + 1, le24(bytes, 27)? + 1)),
        _ => Err(Header::Malformed),
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
    use request_id::testing::OneCall;

    /// A PNG of `width` by `height`, as far as the end of its IHDR's fields.
    pub fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    fn gif(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = b"GIF89a".to_vec();
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes
    }

    /// A JPEG whose frame header sits behind an APP0 segment and fill bytes, as a camera writes one.
    fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        bytes.extend_from_slice(b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
        bytes.extend_from_slice(&[0xFF, 0xFF, 0xC2, 0x00, 0x11, 0x08]);
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.push(3);
        bytes
    }

    fn webp(chunk: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut bytes = b"RIFF\x24\0\0\0WEBP".to_vec();
        bytes.extend_from_slice(chunk);
        bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
        bytes.extend_from_slice(body);
        bytes
    }

    fn webp_lossy(width: u16, height: u16) -> Vec<u8> {
        let mut body = vec![0x30, 0x01, 0x00, 0x9D, 0x01, 0x2A];
        body.extend_from_slice(&width.to_le_bytes());
        body.extend_from_slice(&height.to_le_bytes());
        webp(b"VP8 ", &body)
    }

    fn webp_lossless(width: u32, height: u32) -> Vec<u8> {
        let bits = (width - 1) | (height - 1) << 14;
        let mut body = vec![0x2F];
        body.extend_from_slice(&bits.to_le_bytes());
        webp(b"VP8L", &body)
    }

    fn webp_extended(width: u32, height: u32) -> Vec<u8> {
        let mut body = vec![0x10, 0, 0, 0];
        body.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
        body.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
        webp(b"VP8X", &body)
    }

    /// A first few bytes of each type, as a tool that writes one would start the file.
    fn good() -> Vec<(&'static str, Vec<u8>)> {
        vec![
            ("image/png", png(1, 1)),
            ("image/jpeg", jpeg(1, 1)),
            ("image/gif", b"GIF89a\x01\0\x01\0".to_vec()),
            ("image/gif", b"GIF87a\x01\0\x01\0".to_vec()),
            ("image/webp", webp_lossy(1, 1)),
            ("image/webp", webp_lossless(1, 1)),
            ("image/webp", webp_extended(1, 1)),
            ("audio/mpeg", b"ID3\x04\0\0\0\0\0\0".to_vec()),
            ("audio/mpeg", vec![0xFF, 0xFB, 0x90, 0x64]),
            ("audio/ogg", b"OggS\0\x02\0\0".to_vec()),
            ("audio/wav", b"RIFF\x24\0\0\0WAVEfmt ".to_vec()),
            ("audio/webm", vec![0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42]),
            ("font/woff2", b"wOF2\0\x01\0\0".to_vec()),
            ("font/woff", b"wOFF\0\x01\0\0".to_vec()),
            ("font/ttf", vec![0x00, 0x01, 0x00, 0x00, 0x00, 0x0A]),
            ("font/ttf", b"true\0\x0A\0\x80".to_vec()),
            ("font/otf", b"OTTO\0\x0A\0\x80".to_vec()),
            (
                "application/json",
                br#"{"frames":[1,2,3],"name":"leaf"}"#.to_vec(),
            ),
        ]
    }

    fn checked(content_type: &str, bytes: &[u8]) -> Result<(), Invalid> {
        check(content_type, bytes.len() as u64, bytes)
    }

    #[test]
    fn passes_every_type_that_starts_the_way_it_says() {
        for (content_type, bytes) in good() {
            assert_eq!(checked(content_type, &bytes), Ok(()), "{content_type}");
        }
    }

    /// Each type's bytes under every other type's name, which is the rename a quarantine exists for.
    #[test]
    fn refuses_bytes_declared_as_a_type_they_are_not() {
        let good = good();
        for (declared, _) in &good {
            for (actual, bytes) in &good {
                if declared != actual {
                    assert!(
                        checked(declared, bytes).is_err(),
                        "{actual} passed as {declared}"
                    );
                }
            }
        }
    }

    /// Every header reader, at a size each encoding can state, so a misplaced byte reads as a wrong size.
    #[test]
    fn reads_the_size_out_of_every_image_header() {
        assert_eq!(png_size(&png(640, 480)), Ok((640, 480)));
        assert_eq!(gif_size(&gif(640, 480)), Ok((640, 480)));
        assert_eq!(jpeg_size(&jpeg(640, 480)), Ok((640, 480)));
        assert_eq!(webp_size(&webp_lossy(640, 480)), Ok((640, 480)));
        assert_eq!(webp_size(&webp_lossless(640, 480)), Ok((640, 480)));
        assert_eq!(webp_size(&webp_extended(640, 480)), Ok((640, 480)));
    }

    /// A few hundred bytes can declare a canvas whose decode is gigabytes in a player's tab.
    #[test]
    fn refuses_an_image_past_either_bound() {
        let (side, square) = (MAX_IMAGE_SIDE, 8_192);
        let narrow = side as u16;
        for (content_type, bytes) in [
            ("image/png", png(side, 1)),
            ("image/png", png(square, square)),
            ("image/gif", gif(narrow, 1)),
            ("image/jpeg", jpeg(1, narrow)),
            ("image/webp", webp_lossless(side, 1)),
            ("image/webp", webp_extended(square, square)),
        ] {
            assert_eq!(checked(content_type, &bytes), Ok(()), "{content_type}");
        }
        for (content_type, bytes) in [
            ("image/png", png(side + 1, 1)),
            ("image/gif", gif(narrow + 1, 1)),
            ("image/jpeg", jpeg(1, narrow + 1)),
            ("image/webp", webp_extended(side + 1, 1)),
        ] {
            let message = checked(content_type, &bytes).unwrap_err().0;
            assert!(
                message.contains("pixels a side"),
                "{content_type}: {message}"
            );
        }
        for (content_type, bytes) in [
            ("image/png", png(square, square + 1)),
            ("image/gif", gif(square as u16 + 1, square as u16)),
            ("image/jpeg", jpeg(square as u16, square as u16 + 1)),
            ("image/webp", webp_lossy(16_383, 16_383)),
            ("image/webp", webp_lossless(side, side)),
        ] {
            let message = checked(content_type, &bytes).unwrap_err().0;
            assert!(
                message.contains("at most 67108864 pixels"),
                "{content_type}: {message}"
            );
        }
    }

    #[test]
    fn refuses_an_image_with_no_area() {
        assert!(checked("image/png", &png(0, 10)).is_err());
        assert!(checked("image/gif", &gif(10, 0)).is_err());
        assert!(checked("image/jpeg", &jpeg(10, 0)).is_err());
    }

    /// Cut anywhere between its signature and the end of its size, an image is refused as cut off.
    #[test]
    fn refuses_an_image_cut_off_inside_its_header() {
        for (content_type, whole, signature, size_ends) in [
            ("image/png", png(8, 8), 8, 24),
            ("image/gif", gif(8, 8), 6, 10),
            ("image/jpeg", jpeg(8, 8), 3, 30),
            ("image/webp", webp_lossy(8, 8), 12, 30),
            ("image/webp", webp_lossless(8, 8), 12, 25),
            ("image/webp", webp_extended(8, 8), 12, 30),
        ] {
            assert_eq!(
                checked(content_type, &whole[..size_ends]),
                Ok(()),
                "{content_type}"
            );
            for cut in signature..size_ends {
                let message = checked(content_type, &whole[..cut]).unwrap_err().0;
                assert!(
                    message.contains("ends before"),
                    "{content_type} cut at {cut}: {message}"
                );
            }
        }
    }

    #[test]
    fn refuses_a_header_no_encoder_writes() {
        let mut no_ihdr = png(8, 8);
        no_ihdr[12..16].copy_from_slice(b"tEXt");
        let mut scan_first = vec![0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x08];
        scan_first.extend_from_slice(&[0; 8]);
        let mut no_start_code = webp_lossy(8, 8);
        no_start_code[23] = 0;

        for (content_type, bytes) in [
            ("image/png", no_ihdr),
            ("image/jpeg", scan_first),
            ("image/webp", no_start_code),
            ("image/webp", webp(b"ALPH", &[0; 16])),
        ] {
            let message = checked(content_type, &bytes).unwrap_err().0;
            assert!(
                message.contains("its header is not one"),
                "{content_type}: {message}"
            );
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
        let png = png(1, 1);

        assert_eq!(
            check("image/png", png.len() as u64 + 1, &png),
            Err(Invalid(format!(
                "this upload is {} bytes, not the {} it was declared as",
                png.len(),
                png.len() + 1
            )))
        );
        assert!(check("image/png", png.len() as u64 - 1, &png)
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

    #[tokio::test]
    async fn reads_an_upload_no_further_than_the_limit() {
        let bucket = OneCall::replying("200 OK", &[], [7u8; 64]);

        let read = HttpBucket::new()
            .unwrap()
            .fetch(&format!("{}/uploads/leaf.png", bucket.base), 10)
            .await
            .unwrap();

        assert_eq!(read, Some(vec![7u8; 10]));
        assert!(bucket.received_text().starts_with("GET /uploads/leaf.png"));
    }

    #[tokio::test]
    async fn reads_an_upload_the_bucket_no_longer_holds_as_gone() {
        let bucket = OneCall::replying("404 Not Found", &[], "");

        let read = HttpBucket::new()
            .unwrap()
            .fetch(&bucket.base, 10)
            .await
            .unwrap();

        assert_eq!(read, None);
    }

    /// A presign that lapsed or a bucket that failed is the fleet's, so it is an error to retry.
    #[tokio::test]
    async fn a_refused_read_is_an_error_rather_than_a_verdict() {
        let bucket = OneCall::replying("403 Forbidden", &[], "");

        assert!(HttpBucket::new()
            .unwrap()
            .fetch(&bucket.base, 10)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn copies_with_the_signed_type_and_answers_the_version_it_made() {
        let bucket = OneCall::replying("200 OK", &["x-amz-version-id: 3HL4kqtJlcpXroDT"], "");

        let version = HttpBucket::new()
            .unwrap()
            .publish(
                &format!("{}/assets/leaf.png", bucket.base),
                "image/png",
                b"\x89PNG".to_vec(),
            )
            .await
            .unwrap();

        assert_eq!(version, "3HL4kqtJlcpXroDT");
        let sent = bucket.received_text().to_lowercase();
        assert!(sent.starts_with("put /assets/leaf.png"), "{sent}");
        assert!(sent.contains("content-type: image/png"), "{sent}");
        assert!(sent.ends_with("\u{fffd}png"), "{sent}");
    }

    #[tokio::test]
    async fn a_copy_the_bucket_kept_no_version_of_is_an_error() {
        let bucket = OneCall::replying("200 OK", &[], "");

        let copied = HttpBucket::new()
            .unwrap()
            .publish(&bucket.base, "image/png", b"\x89PNG".to_vec())
            .await;

        assert!(copied.is_err());
    }
}
