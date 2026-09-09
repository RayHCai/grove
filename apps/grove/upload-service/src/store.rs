//! The object store: bytes named by their own SHA-256, and the seam a backing store answers.
//!
//! An object is never resident, so the trait is written in terms of a boxed byte stream rather than
//! a buffer — the cost of one upload is a chunk plus a hasher, whatever the object weighs. The
//! filesystem implementation writes to a temp file and renames into place: a partial object must
//! never be readable under its final name, and a rename is the only atomic step a filesystem gives.

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result};
use async_trait::async_trait;
use bytes::Bytes;
use futures_util::stream::{Stream, StreamExt};
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

/// A body on its way in or out.
///
/// Boxed rather than generic because the handlers hold an `Arc<dyn ObjectStore>`, and a trait
/// generic over the stream it takes is not dyn-safe.
pub type ByteStream = Pin<Box<dyn Stream<Item = std::io::Result<Bytes>> + Send>>;

/// What an object with no declared type is stored and served as.
pub const DEFAULT_CONTENT_TYPE: &str = "application/octet-stream";

const HASH_LEN: usize = 64;

/// A validated content address: 64 lowercase hex characters.
///
/// A type rather than a `&str` because the check that says a name is a SHA-256 is the same check
/// that keeps a path built from it inside the object root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectHash(String);

impl ObjectHash {
    pub fn parse(raw: &str) -> Option<Self> {
        let hex = raw.len() == HASH_LEN
            && raw
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
        hex.then(|| Self(raw.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What a caller asks the store to keep, beside the bytes themselves.
pub struct PutRequest {
    pub hash: ObjectHash,
    pub content_type: String,
    /// Bytes past which the upload is abandoned, enforced here because this is where they are read.
    pub max_bytes: u64,
}

/// What a put did, which is the whole difference between a 201 and a 200.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stored {
    Created,
    AlreadyPresent,
}

/// What a reader needs before the bytes: the two headers a `HEAD` is.
#[derive(Debug, Clone)]
pub struct ObjectHead {
    pub byte_length: u64,
    pub content_type: String,
}

#[derive(Debug)]
pub enum PutError {
    /// The bytes are not the ones the name promised, which for a content address is a corrupt or
    /// hostile upload rather than a naming disagreement.
    HashMismatch {
        computed: String,
    },
    TooLarge,
    /// The peer's body failed or ended before it was whole.
    Source(std::io::Error),
    /// This side failed: a disk, a permission, a full filesystem.
    Storage(anyhow::Error),
}

#[async_trait]
pub trait ObjectStore: Send + Sync + 'static {
    /// Streams `body` into storage while hashing it, and keeps it only if the hash is its name.
    async fn put(&self, request: PutRequest, body: ByteStream) -> Result<Stored, PutError>;
    /// The head and the bytes, or `None` for an address nothing is stored under.
    async fn get(&self, hash: &ObjectHash) -> Result<Option<(ObjectHead, ByteStream)>>;
    async fn head(&self, hash: &ObjectHash) -> Result<Option<ObjectHead>>;
    /// `true` when this call is the one that removed it.
    async fn delete(&self, hash: &ObjectHash) -> Result<bool>;
}

/// Objects on a local filesystem: `objects/<ab>/<hash>` for the bytes, a `.type` sidecar beside it,
/// and `incoming/` for uploads that have not earned their name yet.
pub struct FileStore {
    objects: PathBuf,
    incoming: PathBuf,
    next_temp: AtomicU64,
}

impl FileStore {
    /// `incoming/` is a sibling of `objects/` under one root, because a rename is atomic only within
    /// one filesystem and two directories under one root is the cheapest way to guarantee that.
    pub async fn open(root: PathBuf) -> Result<Self> {
        let objects = root.join("objects");
        let incoming = root.join("incoming");
        for directory in [&objects, &incoming] {
            fs::create_dir_all(directory)
                .await
                .with_context(|| format!("creating {}", directory.display()))?;
        }
        Ok(Self {
            objects,
            incoming,
            next_temp: AtomicU64::new(0),
        })
    }

    /// One directory per two-hex prefix: 256 shards, so a million objects is four thousand entries a
    /// directory rather than one listing no tool will open.
    fn object_path(&self, hash: &ObjectHash) -> PathBuf {
        self.objects.join(&hash.as_str()[..2]).join(hash.as_str())
    }

    fn type_path(&self, hash: &ObjectHash) -> PathBuf {
        self.objects
            .join(&hash.as_str()[..2])
            .join(format!("{}.type", hash.as_str()))
    }

    /// Unique per upload rather than per hash: two peers may be sending the same object at once, and
    /// one temp file between them would be two interleaved bodies.
    fn temp_path(&self) -> PathBuf {
        let ordinal = self.next_temp.fetch_add(1, Ordering::Relaxed);
        self.incoming
            .join(format!("{}-{ordinal}.part", std::process::id()))
    }

    /// The sidecar holds the content type and nothing else: a JSON envelope here would be a schema
    /// to migrate for one string, and an object whose sidecar is gone is still its own bytes.
    async fn content_type(&self, hash: &ObjectHash) -> String {
        fs::read_to_string(self.type_path(hash))
            .await
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_CONTENT_TYPE.to_owned())
    }

    /// Hashes the whole body, writing it to `temp` when there is one to write to.
    ///
    /// A body whose object is already stored is hashed and dropped rather than skipped: the answer
    /// is still a claim about bytes this service checked, and writing megabytes it already holds is
    /// what every unchanged bundle a rebuild re-uploads would otherwise cost.
    async fn absorb(
        &self,
        temp: Option<&Path>,
        request: &PutRequest,
        mut body: ByteStream,
    ) -> Result<(), PutError> {
        let mut file = match temp {
            None => None,
            Some(path) => Some(
                fs::File::create(path)
                    .await
                    .map_err(|err| storage(err, format!("creating {}", path.display())))?,
            ),
        };

        let mut hasher = Sha256::new();
        let mut written: u64 = 0;
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(PutError::Source)?;
            written += chunk.len() as u64;
            if written > request.max_bytes {
                return Err(PutError::TooLarge);
            }
            hasher.update(&chunk);
            if let Some(file) = file.as_mut() {
                file.write_all(&chunk)
                    .await
                    .map_err(|err| storage(err, "writing an upload"))?;
            }
        }

        if let Some(file) = file {
            // On the device before the rename, because the rename is what publishes the name and a
            // crash between the two would publish a file with nothing in it.
            file.sync_all()
                .await
                .map_err(|err| storage(err, "flushing an upload"))?;
        }

        let computed = hex(hasher.finalize());
        if computed != request.hash.as_str() {
            return Err(PutError::HashMismatch { computed });
        }
        Ok(())
    }

    async fn commit(&self, temp: &Path, request: &PutRequest) -> Result<Stored, PutError> {
        let target = self.object_path(&request.hash);
        if let Some(shard) = target.parent() {
            fs::create_dir_all(shard)
                .await
                .map_err(|err| storage(err, "creating an object shard"))?;
        }
        // The sidecar lands first: the blob's rename is what makes the object readable, so a type
        // written after it would leave a window where a reader finds bytes and no type.
        fs::write(self.type_path(&request.hash), &request.content_type)
            .await
            .map_err(|err| storage(err, "writing a content type"))?;

        if let Err(err) = fs::rename(temp, &target).await {
            let _ = fs::remove_file(temp).await;
            // A rename can still lose to a concurrent put of the same bytes — a directory that
            // went away, a handle held open — and identical content under the name it hashes to is
            // the result either way, so the object is present rather than the write failed.
            if !fs::try_exists(&target).await.unwrap_or(false) {
                return Err(storage(err, "publishing an object"));
            }
            return Ok(Stored::AlreadyPresent);
        }
        Ok(Stored::Created)
    }
}

#[async_trait]
impl ObjectStore for FileStore {
    async fn put(&self, request: PutRequest, body: ByteStream) -> Result<Stored, PutError> {
        let target = self.object_path(&request.hash);
        let present = fs::try_exists(&target)
            .await
            .map_err(|err| storage(err, "looking for an object"))?;
        let temp = (!present).then(|| self.temp_path());

        match self.absorb(temp.as_deref(), &request, body).await {
            Err(failure) => {
                // The temp file goes with the failure: it has no final name and never will, so
                // leaving it is a file nothing can ever read and nothing else would ever remove.
                if let Some(temp) = &temp {
                    let _ = fs::remove_file(temp).await;
                }
                Err(failure)
            }
            Ok(()) => match &temp {
                // The stored content type stands: the first put of an address is the one that
                // named its type, and the bytes a later put carries are by definition the same.
                None => Ok(Stored::AlreadyPresent),
                Some(temp) => self.commit(temp, &request).await,
            },
        }
    }

    async fn get(&self, hash: &ObjectHash) -> Result<Option<(ObjectHead, ByteStream)>> {
        let path = self.object_path(hash);
        let file = match fs::File::open(&path).await {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => {
                return Err(anyhow::Error::new(err).context(format!("opening {}", path.display())))
            }
        };
        let byte_length = file.metadata().await.context("measuring an object")?.len();
        let head = ObjectHead {
            byte_length,
            content_type: self.content_type(hash).await,
        };
        Ok(Some((head, Box::pin(ReaderStream::new(file)))))
    }

    async fn head(&self, hash: &ObjectHash) -> Result<Option<ObjectHead>> {
        match fs::metadata(self.object_path(hash)).await {
            Ok(metadata) => Ok(Some(ObjectHead {
                byte_length: metadata.len(),
                content_type: self.content_type(hash).await,
            })),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(anyhow::Error::new(err).context("reading an object header")),
        }
    }

    async fn delete(&self, hash: &ObjectHash) -> Result<bool> {
        // The blob goes first: its absence is the object's absence, so a failure after it leaves a
        // sidecar nothing points at rather than a name that still reads.
        match fs::remove_file(self.object_path(hash)).await {
            Ok(()) => {
                let _ = fs::remove_file(self.type_path(hash)).await;
                Ok(true)
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(err) => Err(anyhow::Error::new(err).context("removing an object")),
        }
    }
}

fn storage(err: std::io::Error, doing: impl Into<String>) -> PutError {
    PutError::Storage(anyhow::Error::new(err).context(doing.into()))
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    let mut out = String::with_capacity(HASH_LEN);
    for byte in bytes.as_ref() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &[u8] = b"a bundle, as far as this half is concerned";

    fn sha256(bytes: &[u8]) -> ObjectHash {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        ObjectHash::parse(&hex(hasher.finalize())).unwrap()
    }

    fn stream(chunks: Vec<std::io::Result<Bytes>>) -> ByteStream {
        Box::pin(futures_util::stream::iter(chunks))
    }

    fn whole(bytes: &'static [u8]) -> ByteStream {
        stream(vec![Ok(Bytes::from_static(bytes))])
    }

    fn request(hash: ObjectHash) -> PutRequest {
        PutRequest {
            hash,
            content_type: "application/wasm".to_owned(),
            max_bytes: 1024,
        }
    }

    async fn scratch() -> (tempfile::TempDir, FileStore) {
        let root = tempfile::tempdir().unwrap();
        let store = FileStore::open(root.path().to_path_buf()).await.unwrap();
        (root, store)
    }

    fn incoming_is_empty(root: &tempfile::TempDir) -> bool {
        std::fs::read_dir(root.path().join("incoming"))
            .unwrap()
            .next()
            .is_none()
    }

    async fn drain(mut body: ByteStream) -> Vec<u8> {
        let mut out = Vec::new();
        while let Some(chunk) = body.next().await {
            out.extend_from_slice(&chunk.unwrap());
        }
        out
    }

    #[tokio::test]
    async fn parses_only_a_lowercase_sha256() {
        assert!(ObjectHash::parse(&"a".repeat(64)).is_some());
        assert!(ObjectHash::parse(&"A".repeat(64)).is_none());
        assert!(ObjectHash::parse(&"a".repeat(63)).is_none());
        // The same check is the traversal guard, which is why it is a type rather than a lint.
        assert!(ObjectHash::parse("../../etc/passwd").is_none());
    }

    #[tokio::test]
    async fn stores_the_bytes_and_serves_them_back() {
        let (_root, store) = scratch().await;
        let hash = sha256(BODY);
        assert_eq!(
            store.put(request(hash.clone()), whole(BODY)).await.unwrap(),
            Stored::Created
        );

        let head = store.head(&hash).await.unwrap().unwrap();
        assert_eq!(head.byte_length, BODY.len() as u64);
        assert_eq!(head.content_type, "application/wasm");

        let (head, body) = store.get(&hash).await.unwrap().unwrap();
        assert_eq!(head.byte_length, BODY.len() as u64);
        assert_eq!(drain(body).await, BODY);

        assert!(store.delete(&hash).await.unwrap());
        assert!(!store.delete(&hash).await.unwrap());
        assert!(store.head(&hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_second_put_of_identical_bytes_is_already_present() {
        let (_root, store) = scratch().await;
        let hash = sha256(BODY);
        assert_eq!(
            store.put(request(hash.clone()), whole(BODY)).await.unwrap(),
            Stored::Created
        );
        assert_eq!(
            store.put(request(hash.clone()), whole(BODY)).await.unwrap(),
            Stored::AlreadyPresent
        );
        let (_, body) = store.get(&hash).await.unwrap().unwrap();
        assert_eq!(drain(body).await, BODY);
    }

    #[tokio::test]
    async fn refuses_bytes_that_are_not_their_name_and_stores_nothing() {
        let (root, store) = scratch().await;
        let claimed = sha256(b"some other object entirely");
        let failure = store
            .put(request(claimed.clone()), whole(BODY))
            .await
            .unwrap_err();

        match failure {
            PutError::HashMismatch { computed } => assert_eq!(computed, sha256(BODY).as_str()),
            other => panic!("expected a mismatch, got {other:?}"),
        }
        assert!(store.head(&claimed).await.unwrap().is_none());
        // Nor under the name the bytes actually have: a mismatch stores nothing at all.
        assert!(store.head(&sha256(BODY)).await.unwrap().is_none());
        assert!(incoming_is_empty(&root));
    }

    #[tokio::test]
    async fn a_body_that_fails_mid_stream_never_appears_under_its_final_name() {
        let (root, store) = scratch().await;
        let hash = sha256(BODY);
        let failure = store
            .put(
                request(hash.clone()),
                stream(vec![
                    Ok(Bytes::from_static(b"a bundle, as far")),
                    Err(std::io::Error::other("the socket went away")),
                ]),
            )
            .await
            .unwrap_err();

        assert!(matches!(failure, PutError::Source(_)));
        assert!(store.head(&hash).await.unwrap().is_none());
        assert!(store.get(&hash).await.unwrap().is_none());
        assert!(incoming_is_empty(&root));
    }

    #[tokio::test]
    async fn abandons_a_body_that_runs_past_the_ceiling() {
        let (root, store) = scratch().await;
        let hash = sha256(BODY);
        let mut oversized = request(hash.clone());
        oversized.max_bytes = 8;

        let failure = store.put(oversized, whole(BODY)).await.unwrap_err();
        assert!(matches!(failure, PutError::TooLarge));
        assert!(store.head(&hash).await.unwrap().is_none());
        assert!(incoming_is_empty(&root));
    }

    #[tokio::test]
    async fn serves_the_default_type_for_an_object_whose_sidecar_is_gone() {
        let (root, store) = scratch().await;
        let hash = sha256(BODY);
        store.put(request(hash.clone()), whole(BODY)).await.unwrap();
        std::fs::remove_file(
            root.path()
                .join("objects")
                .join(&hash.as_str()[..2])
                .join(format!("{}.type", hash.as_str())),
        )
        .unwrap();

        let head = store.head(&hash).await.unwrap().unwrap();
        assert_eq!(head.content_type, DEFAULT_CONTENT_TYPE);
    }
}
