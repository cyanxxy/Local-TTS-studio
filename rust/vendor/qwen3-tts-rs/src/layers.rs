// Copyright 2026 Claude Code on behalf of Michael Yuan.
// SPDX-License-Identifier: Apache-2.0

//! Neural network layer implementations for Qwen3 TTS.
//!
//! This module implements the core neural network layers used by the
//! TTS model, including attention, MLP, normalization, and vocoder layers.

#[cfg(feature = "mlx")]
use crate::backend::mlx;
use crate::tensor::{DType, Device, Tensor};
use crate::trace::TraceWriter;
use std::collections::HashMap;
#[cfg(feature = "tch-backend")]
use tch::nn;

/// RMS Normalization layer.
pub struct RMSNorm {
    weight: Tensor,
    eps: f64,
}

impl RMSNorm {
    /// Create a new RMSNorm layer.
    #[cfg(feature = "tch-backend")]
    pub fn new(vs: &nn::Path, hidden_size: i64, eps: f64) -> Self {
        let weight = vs.var("weight", &[hidden_size], nn::Init::Const(1.0));
        Self {
            weight: Tensor::from_tch(weight),
            eps,
        }
    }

    /// Load RMSNorm from pre-loaded weights.
    pub fn from_weights(weight: Tensor, eps: f64) -> Self {
        Self { weight, eps }
    }

    /// Apply RMS normalization.
    pub fn forward(&self, x: &Tensor) -> Tensor {
        // Use MLX fused RMS norm kernel for better performance on Apple Silicon
        #[cfg(feature = "mlx")]
        {
            return Tensor::from_mlx(mlx::ops::fast_rms_norm(
                x.as_mlx(),
                self.weight.as_mlx(),
                self.eps as f32,
            ))
            .to_dtype(x.kind());
        }
        #[cfg(not(feature = "mlx"))]
        {
            let x_f32 = x.to_dtype(DType::Float32);

            // Calculate RMS: sqrt(mean(x^2) + eps)
            let variance = x_f32.pow_scalar(2.0).mean_dim(&[-1], true);
            let rms = (variance + self.eps).sqrt();

            // Clamp RMS to avoid division by zero
            let rms = rms.clamp_min(1e-8);

            // Normalize and scale
            let normalized = &x_f32 / &rms;
            let output = normalized * &self.weight;

            output.to_dtype(x.kind())
        }
    }
}

/// Linear layer with optional bias.
pub struct Linear {
    weight: Tensor,
    bias: Option<Tensor>,
    #[cfg(feature = "mlx")]
    quantization: Option<QuantizedLinear>,
}

#[cfg(feature = "mlx")]
struct QuantizedLinear {
    scales: Tensor,
    biases: Option<Tensor>,
    group_size: i32,
    bits: i32,
}

impl Linear {
    /// Create a new Linear layer with Xavier initialization.
    #[cfg(feature = "tch-backend")]
    pub fn new(vs: &nn::Path, in_features: i64, out_features: i64) -> Self {
        // Use Xavier/Glorot uniform initialization as a reasonable default
        let std = (2.0 / (in_features + out_features) as f64).sqrt();
        let weight = vs.var(
            "weight",
            &[out_features, in_features],
            nn::Init::Uniform { lo: -std, up: std },
        );
        Self::from_weights(Tensor::from_tch(weight))
    }

    /// Load Linear from pre-loaded weight tensor (no bias).
    pub fn from_weights(weight: Tensor) -> Self {
        Self::from_parts(weight, None, None, None)
    }

    /// Load Linear from pre-loaded weight and bias tensors.
    pub fn from_weights_with_bias(weight: Tensor, bias: Tensor) -> Self {
        Self::from_parts(weight, Some(bias), None, None)
    }

    /// Load Linear from `prefix.weight`, optional `prefix.bias`, and optional MLX quantization tensors.
    pub fn from_weight_map(
        weights: &HashMap<String, Tensor>,
        prefix: &str,
        device: Device,
    ) -> Option<Self> {
        let weight = weights.get(&format!("{prefix}.weight"))?.to_device(device);
        let bias = weights
            .get(&format!("{prefix}.bias"))
            .map(|tensor| tensor.to_device(device).to_dtype(DType::Float32));
        #[cfg(feature = "mlx")]
        {
            let scales = weights
                .get(&format!("{prefix}.scales"))
                .map(|tensor| tensor.to_device(device));
            let quant_biases = weights
                .get(&format!("{prefix}.biases"))
                .map(|tensor| tensor.to_device(device));
            return Some(Self::from_parts(weight, bias, scales, quant_biases));
        }
        #[cfg(not(feature = "mlx"))]
        {
            Some(Self::from_parts(weight, bias, None, None))
        }
    }

    fn from_parts(
        weight: Tensor,
        bias: Option<Tensor>,
        #[cfg(feature = "mlx")] scales: Option<Tensor>,
        #[cfg(feature = "mlx")] quant_biases: Option<Tensor>,
        #[cfg(not(feature = "mlx"))] _scales: Option<Tensor>,
        #[cfg(not(feature = "mlx"))] _quant_biases: Option<Tensor>,
    ) -> Self {
        #[cfg(feature = "mlx")]
        {
            if let Some(scales) = scales {
                let quantization =
                    infer_quantization(&weight, &scales).map(|(group_size, bits)| {
                        QuantizedLinear {
                            scales,
                            biases: quant_biases,
                            group_size,
                            bits,
                        }
                    });
                return Self {
                    weight,
                    bias,
                    quantization,
                };
            }
            Self {
                weight: weight.to_dtype(DType::Float32),
                bias,
                quantization: None,
            }
        }
        #[cfg(not(feature = "mlx"))]
        {
            Self {
                weight: linear_weight(weight),
                bias: bias.map(linear_weight),
            }
        }
    }

    /// Apply linear transformation: x @ W^T + bias.
    pub fn forward(&self, x: &Tensor) -> Tensor {
        #[cfg(feature = "mlx")]
        let out = if let Some(quantization) = &self.quantization {
            Tensor::from_mlx(mlx::ops::quantized_matmul(
                x.as_mlx(),
                self.weight.as_mlx(),
                quantization.scales.as_mlx(),
                quantization.biases.as_ref().map(|biases| biases.as_mlx()),
                true,
                quantization.group_size,
                quantization.bits,
                "affine",
            ))
        } else {
            x.matmul(&self.weight.tr())
        };
        #[cfg(not(feature = "mlx"))]
        let out = x.matmul(&self.weight.tr());

        if let Some(ref bias) = self.bias {
            #[cfg(feature = "mlx")]
            {
                if self.quantization.is_some() {
                    return &out + bias;
                }
                return Tensor::from_mlx(mlx::ops::addmm(
                    bias.as_mlx(),
                    x.as_mlx(),
                    self.weight.tr().as_mlx(),
                ));
            }
            #[cfg(not(feature = "mlx"))]
            {
                &out + bias
            }
        } else {
            out
        }
    }
}

#[cfg(feature = "mlx")]
fn infer_quantization(weight: &Tensor, scales: &Tensor) -> Option<(i32, i32)> {
    let weight_shape = weight.size();
    let scale_shape = scales.size();
    if weight_shape.len() != 2 || scale_shape.len() != 2 || scale_shape[1] == 0 {
        return None;
    }
    let group_size = 64;
    let numerator = weight_shape[1] * 32;
    let denominator = scale_shape[1] * group_size;
    if numerator % denominator != 0 {
        return None;
    }
    let bits = numerator / denominator;
    if matches!(bits, 2 | 3 | 4 | 6 | 8) {
        Some((group_size as i32, bits as i32))
    } else {
        None
    }
}

#[cfg(not(feature = "mlx"))]
fn linear_weight(weight: Tensor) -> Tensor {
    weight.to_dtype(DType::Float32)
}

/// Transformer key/value cache for autoregressive decoding.
#[derive(Debug, Clone, Default)]
pub struct KVCache {
    key: Option<Tensor>,
    value: Option<Tensor>,
    offset: i64,
    capacity: i64,
}

impl KVCache {
    /// Number of sequence positions to allocate when growing the cache.
    pub const STEP: i64 = 256;

    /// Create an empty key/value cache.
    pub fn new() -> Self {
        Self::default()
    }

    /// Return the number of cached sequence positions.
    pub fn len(&self) -> i64 {
        self.offset
    }

    /// Remove all cached key/value tensors.
    pub fn clear(&mut self) {
        self.key = None;
        self.value = None;
        self.offset = 0;
        self.capacity = 0;
    }

    /// Reset logical cache length while keeping allocated storage for reuse.
    pub fn reset(&mut self) {
        self.offset = 0;
    }

    /// Append new key/value tensors and return populated cache slices.
    #[cfg(feature = "mlx")]
    pub fn update_and_fetch(&mut self, key: Tensor, value: Tensor) -> (Tensor, Tensor) {
        let key_shape = key.size();
        let value_shape = value.size();
        let prev = self.offset;
        let added = key_shape[2];
        let needed = prev + added;

        if self.key.is_none() || needed > self.capacity {
            let blocks = (added + Self::STEP - 1) / Self::STEP;
            let grow_by = blocks * Self::STEP;
            let new_key = Tensor::zeros(
                &[key_shape[0], key_shape[1], grow_by, key_shape[3]],
                key.kind(),
                key.device(),
            );
            let new_value = Tensor::zeros(
                &[value_shape[0], value_shape[1], grow_by, value_shape[3]],
                value.kind(),
                value.device(),
            );
            self.key = Some(if let Some(cache_key) = &self.key {
                Tensor::cat(&[cache_key.shallow_clone(), new_key], 2)
            } else {
                new_key
            });
            self.value = Some(if let Some(cache_value) = &self.value {
                Tensor::cat(&[cache_value.shallow_clone(), new_value], 2)
            } else {
                new_value
            });
            self.capacity += grow_by;
        }

        self.offset = needed;
        let full_key = self.update_slice(self.key.as_ref().unwrap(), &key, prev, needed);
        let full_value = self.update_slice(self.value.as_ref().unwrap(), &value, prev, needed);
        self.key = Some(full_key);
        self.value = Some(full_value);

        (
            self.key.as_ref().unwrap().narrow(2, 0, self.offset),
            self.value.as_ref().unwrap().narrow(2, 0, self.offset),
        )
    }

    /// Append new key/value tensors and return populated cache slices.
    #[cfg(not(feature = "mlx"))]
    pub fn update_and_fetch(&mut self, key: Tensor, value: Tensor) -> (Tensor, Tensor) {
        let key = if let Some(previous_key) = &self.key {
            Tensor::cat(&[previous_key.shallow_clone(), key], 2)
        } else {
            key
        };
        let value = if let Some(previous_value) = &self.value {
            Tensor::cat(&[previous_value.shallow_clone(), value], 2)
        } else {
            value
        };
        self.offset = key.size()[2];
        self.capacity = self.offset;
        self.key = Some(key.shallow_clone());
        self.value = Some(value.shallow_clone());
        (key, value)
    }

    #[cfg(feature = "mlx")]
    fn update_slice(
        &self,
        cache: &Tensor,
        update: &Tensor,
        start_index: i64,
        stop_index: i64,
    ) -> Tensor {
        let shape = cache.size();
        let start = [0, 0, start_index as i32, 0];
        let stop = [
            shape[0] as i32,
            shape[1] as i32,
            stop_index as i32,
            shape[3] as i32,
        ];
        let strides = [1, 1, 1, 1];
        Tensor::from_mlx(mlx::ops::slice_update(
            cache.as_mlx(),
            update.as_mlx(),
            &start,
            &stop,
            &strides,
        ))
    }
}

/// Rotary Position Embedding (RoPE).
#[allow(dead_code)]
pub struct RotaryEmbedding {
    cos_cache: Tensor,
    sin_cache: Tensor,
    inv_freq: Tensor,
    dim: i64,
    _theta: f64,
}

impl RotaryEmbedding {
    /// Create new rotary embeddings with the given dimension and max sequence length.
    pub fn new(dim: i64, max_seq_len: i64, theta: f64, device: Device) -> Self {
        let half_dim = dim / 2;

        // Create inverse frequencies
        let inv_freq: Vec<f32> = (0..half_dim)
            .map(|i| 1.0 / (theta as f32).powf((2 * i) as f32 / dim as f32))
            .collect();
        let inv_freq = Tensor::from_slice_f32(&inv_freq).to_device(device);

        // Create position indices
        let positions: Vec<f32> = (0..max_seq_len).map(|i| i as f32).collect();
        let positions = Tensor::from_slice_f32(&positions)
            .view(&[max_seq_len, 1])
            .to_device(device);

        // Compute frequencies: positions * inv_freq (outer product)
        let freqs = positions.matmul(&inv_freq.view(&[1, half_dim]));

        // Compute cos and sin caches
        let cos_cache = freqs.cos();
        let sin_cache = freqs.sin();

        Self {
            cos_cache,
            sin_cache,
            inv_freq,
            dim,
            _theta: theta,
        }
    }

    /// Apply rotary embedding to query and key tensors.
    pub fn forward(&self, q: &Tensor, k: &Tensor, seq_len: i64) -> (Tensor, Tensor) {
        self.forward_with_offset(q, k, seq_len, 0)
    }

    /// Apply rotary embedding with a cache offset for incremental decoding.
    pub fn forward_with_offset(
        &self,
        q: &Tensor,
        k: &Tensor,
        seq_len: i64,
        offset: i64,
    ) -> (Tensor, Tensor) {
        let positions = Tensor::arange_f(
            offset as f64,
            (offset + seq_len) as f64,
            1.0,
            DType::Float32,
            q.device(),
        )
        .view(&[seq_len, 1]);
        let freqs = positions.matmul(&self.inv_freq.view(&[1, self.dim / 2]));
        let cos = freqs.cos().to_dtype(q.kind());
        let sin = freqs.sin().to_dtype(q.kind());

        let q_embed = self.apply_rope(q, &cos, &sin);
        let k_embed = self.apply_rope(k, &cos, &sin);

        (q_embed, k_embed)
    }

    fn apply_rope(&self, x: &Tensor, cos: &Tensor, sin: &Tensor) -> Tensor {
        let half_dim = self.dim / 2;

        // x has shape [batch, heads, seq, dim]
        // cos/sin have shape [seq, half_dim]
        // We need to reshape cos/sin for broadcasting: [1, 1, seq, half_dim]

        // Split into first and second half along last dimension
        let x1 = x.narrow(-1, 0, half_dim); // [batch, heads, seq, half_dim]
        let x2 = x.narrow(-1, half_dim, half_dim); // [batch, heads, seq, half_dim]

        // Reshape cos/sin for broadcasting: [seq, half_dim] -> [1, 1, seq, half_dim]
        let cos = cos.view(&[1, 1, -1, half_dim]);
        let sin = sin.view(&[1, 1, -1, half_dim]);

        // Apply rotation to each half:
        // out1 = x1 * cos - x2 * sin
        // out2 = x1 * sin + x2 * cos
        let out1 = &x1 * &cos - &x2 * &sin;
        let out2 = &x1 * &sin + &x2 * &cos;

        // Concatenate back
        Tensor::cat(&[out1, out2], -1)
    }
}

/// Multi-Head Attention with Grouped Query Attention (GQA) support.
pub struct Attention {
    q_proj: Linear,
    k_proj: Linear,
    v_proj: Linear,
    o_proj: Linear,
    q_norm: Option<Tensor>,
    k_norm: Option<Tensor>,
    num_heads: i64,
    num_kv_heads: i64,
    head_dim: i64,
}

impl Attention {
    /// Create a new grouped-query attention module.
    #[cfg(feature = "tch-backend")]
    pub fn new(
        vs: &nn::Path,
        hidden_size: i64,
        num_heads: i64,
        num_kv_heads: i64,
        head_dim: i64,
    ) -> Self {
        Self {
            q_proj: Linear::new(&vs.sub("q_proj"), hidden_size, num_heads * head_dim),
            k_proj: Linear::new(&vs.sub("k_proj"), hidden_size, num_kv_heads * head_dim),
            v_proj: Linear::new(&vs.sub("v_proj"), hidden_size, num_kv_heads * head_dim),
            o_proj: Linear::new(&vs.sub("o_proj"), num_heads * head_dim, hidden_size),
            q_norm: None,
            k_norm: None,
            num_heads,
            num_kv_heads,
            head_dim,
        }
    }

    /// Load Attention from pre-loaded weights.
    pub fn from_weights(
        weights: &HashMap<String, Tensor>,
        prefix: &str,
        _hidden_size: i64,
        num_heads: i64,
        num_kv_heads: i64,
        head_dim: i64,
        device: Device,
    ) -> Option<Self> {
        let q_proj = Linear::from_weight_map(weights, &format!("{prefix}.q_proj"), device)?;
        let k_proj = Linear::from_weight_map(weights, &format!("{prefix}.k_proj"), device)?;
        let v_proj = Linear::from_weight_map(weights, &format!("{prefix}.v_proj"), device)?;
        let o_proj = Linear::from_weight_map(weights, &format!("{prefix}.o_proj"), device)?;

        // Load Q/K norm if present
        let q_norm = weights
            .get(&format!("{}.q_norm.weight", prefix))
            .map(|t| t.to_device(device));
        let k_norm = weights
            .get(&format!("{}.k_norm.weight", prefix))
            .map(|t| t.to_device(device));

        Some(Self {
            q_proj,
            k_proj,
            v_proj,
            o_proj,
            q_norm,
            k_norm,
            num_heads,
            num_kv_heads,
            head_dim,
        })
    }

    /// Apply multi-head attention with rotary embeddings.
    pub fn forward(
        &self,
        hidden_states: &Tensor,
        rotary_emb: &RotaryEmbedding,
        attention_mask: Option<&Tensor>,
    ) -> Tensor {
        self.forward_with_cache(hidden_states, rotary_emb, attention_mask, None)
    }

    /// Apply multi-head attention and update KV cache when provided.
    pub fn forward_with_cache(
        &self,
        hidden_states: &Tensor,
        rotary_emb: &RotaryEmbedding,
        attention_mask: Option<&Tensor>,
        cache: Option<&mut KVCache>,
    ) -> Tensor {
        let size = hidden_states.size();
        let batch_size = size[0];
        let seq_len = size[1];

        // Project Q, K, V
        let query = self.q_proj.forward(hidden_states);
        let key = self.k_proj.forward(hidden_states);
        let value = self.v_proj.forward(hidden_states);

        // Reshape to (batch, heads, seq, head_dim)
        let query = query
            .view(&[batch_size, seq_len, self.num_heads, self.head_dim])
            .transpose(1, 2);
        let key = key
            .view(&[batch_size, seq_len, self.num_kv_heads, self.head_dim])
            .transpose(1, 2);
        let value = value
            .view(&[batch_size, seq_len, self.num_kv_heads, self.head_dim])
            .transpose(1, 2);

        // Apply Q/K normalization if present (RMS norm per head).
        let query = if let Some(ref q_norm) = self.q_norm {
            #[cfg(feature = "mlx")]
            {
                Tensor::from_mlx(mlx::ops::fast_rms_norm(
                    query.as_mlx(),
                    q_norm.as_mlx(),
                    1e-6,
                ))
            }
            #[cfg(not(feature = "mlx"))]
            {
                let variance = query.pow_scalar(2.0).mean_dim(&[-1], true);
                let rms = (variance + 1e-6).sqrt().clamp_min(1e-8);
                let normalized = query / rms;
                normalized * q_norm
            }
        } else {
            query
        };
        let key = if let Some(ref k_norm) = self.k_norm {
            #[cfg(feature = "mlx")]
            {
                Tensor::from_mlx(mlx::ops::fast_rms_norm(key.as_mlx(), k_norm.as_mlx(), 1e-6))
            }
            #[cfg(not(feature = "mlx"))]
            {
                let variance = key.pow_scalar(2.0).mean_dim(&[-1], true);
                let rms = (variance + 1e-6).sqrt().clamp_min(1e-8);
                let normalized = key / rms;
                normalized * k_norm
            }
        } else {
            key
        };

        // Apply rotary embeddings at the correct cache offset.
        let cache_offset = cache.as_ref().map(|cache| cache.len()).unwrap_or(0);
        let (query, key) = rotary_emb.forward_with_offset(&query, &key, seq_len, cache_offset);

        // Tch attention below does not support grouped-query attention directly,
        // so expand KV heads there. MLX SDPA supports GQA and is faster without
        // materializing repeated KV heads.
        #[cfg(not(feature = "mlx"))]
        let (key, value) = if self.num_kv_heads != self.num_heads {
            let repeat_factor = self.num_heads / self.num_kv_heads;
            let key = key
                .unsqueeze(2)
                .expand(
                    &[
                        batch_size,
                        self.num_kv_heads,
                        repeat_factor,
                        seq_len,
                        self.head_dim,
                    ],
                    false,
                )
                .reshape(&[batch_size, self.num_heads, seq_len, self.head_dim]);
            let value = value
                .unsqueeze(2)
                .expand(
                    &[
                        batch_size,
                        self.num_kv_heads,
                        repeat_factor,
                        seq_len,
                        self.head_dim,
                    ],
                    false,
                )
                .reshape(&[batch_size, self.num_heads, seq_len, self.head_dim]);
            (key, value)
        } else {
            (key, value)
        };
        #[cfg(feature = "mlx")]
        let (key, value) = (key, value);

        let (key, value) = if let Some(cache) = cache {
            cache.update_and_fetch(key, value)
        } else {
            (key, value)
        };

        // Compute attention
        #[cfg(feature = "mlx")]
        let attn_output = {
            // Use MLX fused scaled dot-product attention kernel
            let scale = 1.0 / (self.head_dim as f64).sqrt();
            Tensor::from_mlx(mlx::ops::fast_scaled_dot_product_attention(
                query.as_mlx(),
                key.as_mlx(),
                value.as_mlx(),
                scale as f32,
                attention_mask.map(|m| m.as_mlx()),
            ))
        };
        #[cfg(not(feature = "mlx"))]
        let attn_output = {
            let scale = (self.head_dim as f64).sqrt();
            let attn_weights = query.matmul(&key.transpose(-2, -1)) / scale;

            // Clamp attention weights to prevent overflow in softmax
            let attn_weights = attn_weights.clamp(-100.0, 100.0);

            // Apply attention mask if provided
            let attn_weights = if let Some(mask) = attention_mask {
                attn_weights + mask
            } else {
                attn_weights
            };

            // Softmax with numerical stability
            let attn_weights = attn_weights.softmax(-1);

            // Apply attention to values
            attn_weights.matmul(&value)
        };

        // Reshape back: (batch, heads, seq, head_dim) -> (batch, seq, hidden)
        let attn_output = attn_output.transpose(1, 2).contiguous().view(&[
            batch_size,
            seq_len,
            self.num_heads * self.head_dim,
        ]);

        // Output projection
        self.o_proj.forward(&attn_output)
    }

    fn forward_with_cache_trace(
        &self,
        hidden_states: &Tensor,
        rotary_emb: &RotaryEmbedding,
        attention_mask: Option<&Tensor>,
        cache: Option<&mut KVCache>,
        trace: &mut TraceWriter,
        prefix: &str,
    ) -> std::io::Result<Tensor> {
        let size = hidden_states.size();
        let batch_size = size[0];
        let seq_len = size[1];
        let query = self.q_proj.forward(hidden_states);
        let key = self.k_proj.forward(hidden_states);
        let value = self.v_proj.forward(hidden_states);
        let query = query
            .view(&[batch_size, seq_len, self.num_heads, self.head_dim])
            .transpose(1, 2);
        let key = key
            .view(&[batch_size, seq_len, self.num_kv_heads, self.head_dim])
            .transpose(1, 2);
        let value = value
            .view(&[batch_size, seq_len, self.num_kv_heads, self.head_dim])
            .transpose(1, 2);
        let query = if let Some(ref q_norm) = self.q_norm {
            #[cfg(feature = "mlx")]
            {
                Tensor::from_mlx(mlx::ops::fast_rms_norm(
                    query.as_mlx(),
                    q_norm.as_mlx(),
                    1e-6,
                ))
            }
            #[cfg(not(feature = "mlx"))]
            {
                let variance = query.pow_scalar(2.0).mean_dim(&[-1], true);
                let rms = (variance + 1e-6).sqrt().clamp_min(1e-8);
                (query / rms) * q_norm
            }
        } else {
            query
        };
        let key = if let Some(ref k_norm) = self.k_norm {
            #[cfg(feature = "mlx")]
            {
                Tensor::from_mlx(mlx::ops::fast_rms_norm(key.as_mlx(), k_norm.as_mlx(), 1e-6))
            }
            #[cfg(not(feature = "mlx"))]
            {
                let variance = key.pow_scalar(2.0).mean_dim(&[-1], true);
                let rms = (variance + 1e-6).sqrt().clamp_min(1e-8);
                (key / rms) * k_norm
            }
        } else {
            key
        };
        trace.tensor(&format!("{prefix}/q_normed"), &query)?;
        trace.tensor(&format!("{prefix}/k_normed"), &key)?;
        let cache_offset = cache.as_ref().map(|cache| cache.len()).unwrap_or(0);
        let (query, key) = rotary_emb.forward_with_offset(&query, &key, seq_len, cache_offset);
        trace.tensor(&format!("{prefix}/q_rope"), &query)?;
        trace.tensor(&format!("{prefix}/k_rope"), &key)?;
        let (key, value) = if let Some(cache) = cache {
            cache.update_and_fetch(key, value)
        } else {
            (key, value)
        };
        trace.tensor(&format!("{prefix}/cache_key"), &key)?;
        trace.tensor(&format!("{prefix}/cache_value"), &value)?;
        #[cfg(feature = "mlx")]
        let attn_output = {
            let scale = 1.0 / (self.head_dim as f64).sqrt();
            Tensor::from_mlx(mlx::ops::fast_scaled_dot_product_attention(
                query.as_mlx(),
                key.as_mlx(),
                value.as_mlx(),
                scale as f32,
                attention_mask.map(|m| m.as_mlx()),
            ))
        };
        #[cfg(not(feature = "mlx"))]
        let attn_output = {
            let scale = (self.head_dim as f64).sqrt();
            let attn_weights = query.matmul(&key.transpose(-2, -1)) / scale;
            let attn_weights = if let Some(mask) = attention_mask {
                attn_weights + mask
            } else {
                attn_weights
            };
            attn_weights.softmax(-1).matmul(&value)
        };
        trace.tensor(&format!("{prefix}/sdpa"), &attn_output)?;
        let attn_output = attn_output.transpose(1, 2).contiguous().view(&[
            batch_size,
            seq_len,
            self.num_heads * self.head_dim,
        ]);
        Ok(self.o_proj.forward(&attn_output))
    }

    /// Forward with debug output
    #[cfg(feature = "tch-backend")]
    pub fn forward_debug(
        &self,
        hidden_states: &Tensor,
        rotary_emb: &RotaryEmbedding,
        attention_mask: Option<&Tensor>,
    ) -> Tensor {
        use tch::Kind;

        let check_nan = |name: &str, t: &Tensor| {
            let mean: f64 = t.as_tch().mean(Kind::Float).try_into().unwrap_or(f64::NAN);
            println!(
                "      attn {}: mean={:.6} nan={}",
                name,
                mean,
                mean.is_nan()
            );
        };

        let size = hidden_states.size();
        let batch_size = size[0];
        let seq_len = size[1];

        // Project Q, K, V
        let query = self.q_proj.forward(hidden_states);
        let key = self.k_proj.forward(hidden_states);
        let value = self.v_proj.forward(hidden_states);
        check_nan("q_proj", &query);
        check_nan("k_proj", &key);
        check_nan("v_proj", &value);

        // Reshape to (batch, heads, seq, head_dim)
        let query = query
            .view(&[batch_size, seq_len, self.num_heads, self.head_dim])
            .transpose(1, 2);
        let key = key
            .view(&[batch_size, seq_len, self.num_kv_heads, self.head_dim])
            .transpose(1, 2);
        let value = value
            .view(&[batch_size, seq_len, self.num_kv_heads, self.head_dim])
            .transpose(1, 2);

        // Apply Q/K normalization if present
        let query = if let Some(ref q_norm) = self.q_norm {
            let eps = 1e-6;
            let variance = query.pow_scalar(2.0).mean_dim(&[-1], true);
            let rms = (variance + eps).sqrt().clamp_min(1e-8);
            let normalized = &query / &rms;
            check_nan("q_normalized", &normalized);
            let q_norm_shape = q_norm.size();
            if q_norm_shape.len() == 1 && q_norm_shape[0] == self.head_dim {
                let result = &normalized * q_norm;
                check_nan("q_after_norm", &result);
                result
            } else {
                normalized
            }
        } else {
            query
        };
        let key = if let Some(ref k_norm) = self.k_norm {
            let eps = 1e-6;
            let variance = key.pow_scalar(2.0).mean_dim(&[-1], true);
            let rms = (variance + eps).sqrt().clamp_min(1e-8);
            let normalized = &key / &rms;
            let k_norm_shape = k_norm.size();
            if k_norm_shape.len() == 1 && k_norm_shape[0] == self.head_dim {
                &normalized * k_norm
            } else {
                normalized
            }
        } else {
            key
        };
        check_nan("after_qk_norm", &query);

        // Apply rotary embeddings
        let (query, key) = rotary_emb.forward(&query, &key, seq_len);
        check_nan("after_rope_q", &query);
        check_nan("after_rope_k", &key);

        // Expand KV heads for GQA if needed
        let (key, value) = if self.num_kv_heads != self.num_heads {
            let repeat_factor = self.num_heads / self.num_kv_heads;
            let key = key
                .unsqueeze(2)
                .expand(
                    &[
                        batch_size,
                        self.num_kv_heads,
                        repeat_factor,
                        seq_len,
                        self.head_dim,
                    ],
                    false,
                )
                .reshape(&[batch_size, self.num_heads, seq_len, self.head_dim]);
            let value = value
                .unsqueeze(2)
                .expand(
                    &[
                        batch_size,
                        self.num_kv_heads,
                        repeat_factor,
                        seq_len,
                        self.head_dim,
                    ],
                    false,
                )
                .reshape(&[batch_size, self.num_heads, seq_len, self.head_dim]);
            (key, value)
        } else {
            (key, value)
        };

        // Compute attention scores
        let scale = (self.head_dim as f64).sqrt();
        let attn_weights = query.matmul(&key.transpose(-2, -1)) / scale;
        check_nan("attn_scores", &attn_weights);

        // Apply attention mask if provided
        let attn_weights = if let Some(mask) = attention_mask {
            attn_weights + mask
        } else {
            attn_weights
        };
        check_nan("attn_masked", &attn_weights);

        // Softmax
        let attn_weights = attn_weights.softmax(-1);
        check_nan("attn_softmax", &attn_weights);

        // Apply attention to values
        let attn_output = attn_weights.matmul(&value);
        check_nan("attn_output", &attn_output);

        // Reshape back
        let attn_output = attn_output.transpose(1, 2).contiguous().view(&[
            batch_size,
            seq_len,
            self.num_heads * self.head_dim,
        ]);

        // Output projection
        let result = self.o_proj.forward(&attn_output);
        check_nan("o_proj", &result);
        result
    }
}

/// SwiGLU MLP layer.
pub struct MLP {
    gate_proj: Linear,
    up_proj: Linear,
    down_proj: Linear,
}

impl MLP {
    /// Create a new SwiGLU MLP.
    #[cfg(feature = "tch-backend")]
    pub fn new(vs: &nn::Path, hidden_size: i64, intermediate_size: i64) -> Self {
        Self {
            gate_proj: Linear::new(&vs.sub("gate_proj"), hidden_size, intermediate_size),
            up_proj: Linear::new(&vs.sub("up_proj"), hidden_size, intermediate_size),
            down_proj: Linear::new(&vs.sub("down_proj"), intermediate_size, hidden_size),
        }
    }

    /// Load MLP from pre-loaded weights.
    pub fn from_weights(
        weights: &HashMap<String, Tensor>,
        prefix: &str,
        device: Device,
    ) -> Option<Self> {
        Some(Self {
            gate_proj: Linear::from_weight_map(weights, &format!("{prefix}.gate_proj"), device)?,
            up_proj: Linear::from_weight_map(weights, &format!("{prefix}.up_proj"), device)?,
            down_proj: Linear::from_weight_map(weights, &format!("{prefix}.down_proj"), device)?,
        })
    }

    /// Apply SwiGLU MLP: down(silu(gate(x)) * up(x)).
    pub fn forward(&self, x: &Tensor) -> Tensor {
        // SwiGLU: down(silu(gate(x)) * up(x))
        let gate = self.gate_proj.forward(x).silu();
        let up = self.up_proj.forward(x);
        let hidden = gate * up;
        self.down_proj.forward(&hidden)
    }
}

/// Single Transformer decoder layer.
pub struct TransformerLayer {
    self_attn: Attention,
    mlp: MLP,
    input_layernorm: RMSNorm,
    post_attention_layernorm: RMSNorm,
}

impl TransformerLayer {
    /// Create a new transformer decoder layer.
    #[cfg(feature = "tch-backend")]
    pub fn new(
        vs: &nn::Path,
        hidden_size: i64,
        intermediate_size: i64,
        num_heads: i64,
        num_kv_heads: i64,
        head_dim: i64,
        rms_norm_eps: f64,
    ) -> Self {
        Self {
            self_attn: Attention::new(
                &vs.sub("self_attn"),
                hidden_size,
                num_heads,
                num_kv_heads,
                head_dim,
            ),
            mlp: MLP::new(&vs.sub("mlp"), hidden_size, intermediate_size),
            input_layernorm: RMSNorm::new(&vs.sub("input_layernorm"), hidden_size, rms_norm_eps),
            post_attention_layernorm: RMSNorm::new(
                &vs.sub("post_attention_layernorm"),
                hidden_size,
                rms_norm_eps,
            ),
        }
    }

    /// Load TransformerLayer from pre-loaded weights.
    #[allow(clippy::too_many_arguments)]
    pub fn from_weights(
        weights: &HashMap<String, Tensor>,
        prefix: &str,
        hidden_size: i64,
        _intermediate_size: i64,
        num_heads: i64,
        num_kv_heads: i64,
        head_dim: i64,
        rms_norm_eps: f64,
        device: Device,
    ) -> Option<Self> {
        let self_attn = Attention::from_weights(
            weights,
            &format!("{}.self_attn", prefix),
            hidden_size,
            num_heads,
            num_kv_heads,
            head_dim,
            device,
        )?;

        let mlp = MLP::from_weights(weights, &format!("{}.mlp", prefix), device)?;

        let input_layernorm_weight = weights
            .get(&format!("{}.input_layernorm.weight", prefix))?
            .to_device(device);
        let post_attention_layernorm_weight = weights
            .get(&format!("{}.post_attention_layernorm.weight", prefix))?
            .to_device(device);

        Some(Self {
            self_attn,
            mlp,
            input_layernorm: RMSNorm::from_weights(input_layernorm_weight, rms_norm_eps),
            post_attention_layernorm: RMSNorm::from_weights(
                post_attention_layernorm_weight,
                rms_norm_eps,
            ),
        })
    }

    /// Apply the transformer layer (attention + MLP with residuals).
    pub fn forward(
        &self,
        hidden_states: &Tensor,
        rotary_emb: &RotaryEmbedding,
        attention_mask: Option<&Tensor>,
    ) -> Tensor {
        self.forward_with_cache(hidden_states, rotary_emb, attention_mask, None)
    }

    /// Apply the transformer layer and update KV cache when provided.
    pub fn forward_with_cache(
        &self,
        hidden_states: &Tensor,
        rotary_emb: &RotaryEmbedding,
        attention_mask: Option<&Tensor>,
        cache: Option<&mut KVCache>,
    ) -> Tensor {
        // Self-attention with residual
        let residual = hidden_states;
        let hidden = self.input_layernorm.forward(hidden_states);
        let hidden = self
            .self_attn
            .forward_with_cache(&hidden, rotary_emb, attention_mask, cache);
        let hidden = residual + hidden;

        // MLP with residual
        let residual = &hidden;
        let hidden_norm = self.post_attention_layernorm.forward(&hidden);
        let hidden = self.mlp.forward(&hidden_norm);

        residual + hidden
    }

    /// Apply the transformer layer and write selected tensors for parity tracing.
    pub fn forward_with_cache_trace(
        &self,
        hidden_states: &Tensor,
        rotary_emb: &RotaryEmbedding,
        attention_mask: Option<&Tensor>,
        cache: Option<&mut KVCache>,
        trace: &mut TraceWriter,
        prefix: &str,
    ) -> std::io::Result<Tensor> {
        let residual = hidden_states;
        let hidden = self.input_layernorm.forward(hidden_states);
        trace.tensor(
            &format!("{prefix}/norm1"),
            &hidden.select(1, hidden.size()[1] - 1).unsqueeze(1),
        )?;
        let hidden = self.self_attn.forward_with_cache_trace(
            &hidden,
            rotary_emb,
            attention_mask,
            cache,
            trace,
            &format!("{prefix}/attn_detail"),
        )?;
        trace.tensor(
            &format!("{prefix}/attn"),
            &hidden.select(1, hidden.size()[1] - 1).unsqueeze(1),
        )?;
        let hidden = residual + hidden;
        trace.tensor(
            &format!("{prefix}/after_attn"),
            &hidden.select(1, hidden.size()[1] - 1).unsqueeze(1),
        )?;

        let residual = &hidden;
        let hidden_norm = self.post_attention_layernorm.forward(&hidden);
        trace.tensor(
            &format!("{prefix}/norm2"),
            &hidden_norm
                .select(1, hidden_norm.size()[1] - 1)
                .unsqueeze(1),
        )?;
        let hidden = self.mlp.forward(&hidden_norm);
        trace.tensor(
            &format!("{prefix}/mlp"),
            &hidden.select(1, hidden.size()[1] - 1).unsqueeze(1),
        )?;
        Ok(residual + hidden)
    }

    /// Forward with debug output (for first layer only)
    #[cfg(feature = "tch-backend")]
    pub fn forward_debug(
        &self,
        hidden_states: &Tensor,
        rotary_emb: &RotaryEmbedding,
        attention_mask: Option<&Tensor>,
    ) -> Tensor {
        let check_nan = |name: &str, t: &Tensor| {
            let mean: f64 = t
                .as_tch()
                .mean(tch::Kind::Float)
                .try_into()
                .unwrap_or(f64::NAN);
            let has_nan = mean.is_nan();
            println!("    {}: mean={:.6} nan={}", name, mean, has_nan);
        };

        check_nan("input", hidden_states);

        // Self-attention with residual
        let residual = hidden_states;
        let hidden = self.input_layernorm.forward(hidden_states);
        check_nan("after_layernorm", &hidden);

        // Use attention debug
        let hidden = self
            .self_attn
            .forward_debug(&hidden, rotary_emb, attention_mask);
        check_nan("after_attn", &hidden);

        let hidden = residual + hidden;
        check_nan("after_residual1", &hidden);

        // MLP with residual
        let residual = &hidden;
        let hidden_norm = self.post_attention_layernorm.forward(&hidden);
        check_nan("after_post_ln", &hidden_norm);

        let hidden = self.mlp.forward(&hidden_norm);
        check_nan("after_mlp", &hidden);

        let output = residual + hidden;
        check_nan("output", &output);

        output
    }
}

/// Snake activation function for vocoder.
/// snake(x) = x + (1/alpha) * sin(alpha * x)^2
pub fn snake_activation(x: &Tensor, alpha: &Tensor) -> Tensor {
    let sin_part = (x * alpha).sin();
    let sin_sq = sin_part.pow_scalar(2.0);
    x + (sin_sq / alpha)
}

/// 1D Convolution layer.
#[cfg(feature = "tch-backend")]
pub fn conv1d(
    vs: &nn::Path,
    in_channels: i64,
    out_channels: i64,
    kernel_size: i64,
    config: nn::ConvConfig,
) -> nn::Conv1D {
    nn::conv1d(vs, in_channels, out_channels, kernel_size, config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_snake_activation() {
        let x = Tensor::from_slice_f32(&[0.0f32, 1.0, 2.0]);
        let alpha = Tensor::from_slice_f32(&[1.0f32, 1.0, 1.0]);

        let result = snake_activation(&x, &alpha);
        assert_eq!(result.size(), vec![3]);
    }
}
