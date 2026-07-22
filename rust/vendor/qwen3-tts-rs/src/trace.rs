// Copyright 2026 Claude Code on behalf of Michael Yuan.
// SPDX-License-Identifier: Apache-2.0

//! Trace writer for Python MLX parity comparisons.
//!
//! The trace format is JSON Lines. Each event has a stable `name` field that is
//! intended to match the Python oracle trace names under `scripts/trace_python_mlx.py`.

use crate::tensor::Tensor;
use serde_json::{json, Value};
use std::fs::{create_dir_all, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

/// JSONL trace writer used by parity tooling.
pub struct TraceWriter {
    trace_dir: PathBuf,
    events: BufWriter<File>,
    sample_count: usize,
}

impl TraceWriter {
    /// Create a trace writer under `trace_dir`.
    pub fn create(trace_dir: impl AsRef<Path>, sample_count: usize) -> std::io::Result<Self> {
        let trace_dir = trace_dir.as_ref().to_path_buf();
        create_dir_all(&trace_dir)?;
        let events = BufWriter::new(File::create(trace_dir.join("trace.jsonl"))?);
        Ok(Self {
            trace_dir,
            events,
            sample_count,
        })
    }

    /// Return the trace directory.
    pub fn trace_dir(&self) -> &Path {
        &self.trace_dir
    }

    /// Write an arbitrary JSON event with a stable name.
    pub fn event(&mut self, name: &str, mut value: Value) -> std::io::Result<()> {
        if let Value::Object(ref mut map) = value {
            map.insert("name".to_string(), Value::String(name.to_string()));
        }
        serde_json::to_writer(&mut self.events, &value)?;
        self.events.write_all(b"\n")?;
        self.events.flush()
    }

    /// Write metadata fields.
    pub fn metadata(&mut self, name: &str, value: Value) -> std::io::Result<()> {
        let mut object = match value {
            Value::Object(map) => map,
            other => {
                let mut map = serde_json::Map::new();
                map.insert("value".to_string(), other);
                map
            }
        };
        object.insert("kind".to_string(), Value::String("metadata".to_string()));
        self.event(name, Value::Object(object))
    }

    /// Write a list of integer IDs.
    pub fn ids(&mut self, name: &str, values: &[i64]) -> std::io::Result<()> {
        self.event(
            name,
            json!({
                "kind": "ids",
                "len": values.len(),
                "values": values,
            }),
        )
    }

    /// Write a numeric tensor summary. Values are converted to `f32` for summary.
    pub fn tensor(&mut self, name: &str, tensor: &Tensor) -> std::io::Result<()> {
        let contiguous = tensor.contiguous();
        let values = contiguous.to_vec_f32();
        let size = values.len();
        let sample = self.sample_count.min(size);
        let first = values.iter().take(sample).copied().collect::<Vec<_>>();
        let last = values
            .iter()
            .skip(size.saturating_sub(sample))
            .copied()
            .collect::<Vec<_>>();
        let (min, max, mean, probes) = if values.is_empty() {
            (0.0, 0.0, 0.0, Vec::<(usize, f32)>::new())
        } else {
            let mut min = f32::INFINITY;
            let mut max = f32::NEG_INFINITY;
            let mut sum = 0.0f64;
            for value in &values {
                min = min.min(*value);
                max = max.max(*value);
                sum += f64::from(*value);
            }
            let mut probe_indices = vec![
                0,
                values.len() / 7,
                values.len() / 5,
                values.len() / 3,
                values.len() / 2,
                (values.len() * 2) / 3,
                (values.len() * 4) / 5,
                (values.len() * 6) / 7,
                values.len() - 1,
            ];
            probe_indices.sort_unstable();
            probe_indices.dedup();
            let probes = probe_indices
                .into_iter()
                .map(|index| (index, values[index]))
                .collect::<Vec<_>>();
            (min, max, (sum / values.len() as f64) as f32, probes)
        };
        self.event(
            name,
            json!({
                "kind": "tensor",
                "shape": tensor.size(),
                "dtype": format!("{:?}", tensor.kind()),
                "size": size,
                "min": min,
                "max": max,
                "mean": mean,
                "first": first,
                "last": last,
                "probes": probes,
            }),
        )
    }

    /// Write top-k values and indices from the flattened tensor.
    pub fn topk(&mut self, name: &str, tensor: &Tensor, k: usize) -> std::io::Result<()> {
        let contiguous = tensor.contiguous();
        let values = contiguous.to_vec_f32();
        let mut indexed = values
            .iter()
            .enumerate()
            .map(|(index, value)| (index, *value))
            .collect::<Vec<_>>();
        indexed.sort_by(|left, right| right.1.total_cmp(&left.1));
        indexed.truncate(k.min(indexed.len()));
        let indices = indexed.iter().map(|(index, _)| *index).collect::<Vec<_>>();
        let top_values = indexed.iter().map(|(_, value)| *value).collect::<Vec<_>>();
        self.event(
            name,
            json!({
                "kind": "topk",
                "indices": indices,
                "values": top_values,
            }),
        )
    }
}
