//! The seam, in Rust. Every type here mirrors one in `packages/sim/src/batch.ts` field for field,
//! and the field names are the wire — a rename on either side is a silent mismatch, not an error.
//!
//! Envelopes and frames cross as `RawValue`, never `Value`: the host routes by `to` and `class` and
//! reads nothing inside, so parsing one into a tree would allocate it, re-serialize it, and hand V8
//! bytes that are no longer the peer's. A Rust restatement of `@platform/protocol` would be a second
//! copy of a shape that package owns.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// A host-minted id for one established connection, stable for its life.
pub type ConnectionId = String;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedConnection {
    pub connection_id: ConnectionId,
    /// Who the TICKET said this peer is. Never a frame's claim.
    pub identity: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundFrame {
    pub connection_id: ConnectionId,
    /// Validated as JSON but NOT narrowed and never parsed into a tree: the sim owns the narrowing,
    /// since it owns what each field bounds, and these bytes reach it exactly as the peer sent them.
    pub message: Box<RawValue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedRecord {
    pub connection_id: ConnectionId,
    /// `{}` for a host the store holds nothing for; `null` ONLY when the read failed, which is what
    /// stops the leave writing this session's initializers over a save nobody could read.
    pub fields: Option<Box<RawValue>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputBatch {
    pub now_ms: f64,
    pub drain: bool,
    pub opened: Vec<OpenedConnection>,
    pub frames: Vec<InboundFrame>,
    pub closed: Vec<ConnectionId>,
    pub records: Vec<LoadedRecord>,
    pub saved: Vec<String>,
}

impl InputBatch {
    pub fn new(now_ms: f64, drain: bool) -> Self {
        Self {
            now_ms,
            drain,
            opened: Vec::new(),
            frames: Vec::new(),
            closed: Vec::new(),
            records: Vec::new(),
            saved: Vec::new(),
        }
    }
}

/// Which class a frame belongs to, which is the whole of the host's backpressure vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SendClass {
    /// Every op must arrive, in order — the journal does not commute.
    Reliable,
    /// Superseded by the next of its kind, so a backed-up connection may discard it.
    Droppable,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Send {
    /// One entry per recipient. More than one means the frame is byte-identical for all of them,
    /// which is the only thing worth encoding once.
    pub to: Vec<ConnectionId>,
    /// Written to the socket verbatim. The host does not look inside one and must not re-serialize
    /// it: the sim measured a `Welcome` against these exact bytes when it decided whether to chunk.
    pub envelope: Box<RawValue>,
    pub class: SendClass,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseOrder {
    pub connection_id: ConnectionId,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadOrder {
    pub connection_id: ConnectionId,
    pub host_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOrder {
    pub host_key: String,
    pub fields: Box<RawValue>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LogLine {
    pub level: String,
    pub line: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct SimDiagnostics {
    /// Marks and ops dropped as unrepresentable. Nonzero is a bug report, not a failure.
    pub dropped: u64,
    /// Marks whose host died between the write and the send — churn, not a defect.
    pub stale: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputBatch {
    pub tick: u64,
    pub sends: Vec<Send>,
    pub closes: Vec<CloseOrder>,
    pub loads: Vec<LoadOrder>,
    pub saves: Vec<SaveOrder>,
    pub log: Vec<LogLine>,
    pub diagnostics: SimDiagnostics,
}
