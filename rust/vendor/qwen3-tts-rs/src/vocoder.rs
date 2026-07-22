// Copyright 2026 Claude Code on behalf of Michael Yuan.
// SPDX-License-Identifier: Apache-2.0

//! Vocoder implementation for Qwen3 TTS 12Hz decoder.
//!
//! This module implements the speech tokenizer decoder that converts
//! discrete audio codes back to waveforms.

#[cfg(feature = "mlx")]
use crate::backend::mlx;
use crate::error::{Qwen3TTSError, Result};
use crate::layers::KVCache;
use crate::tensor::{DType, Device, Tensor};
use crate::trace::TraceWriter;
use std::collections::HashMap;

/// Configuration for the vocoder decoder.
#[derive(Debug, Clone)]
pub struct VocoderConfig {
    /// Codebook dimension
    pub codebook_dim: i64,
    /// Codebook size
    pub codebook_size: i64,
    /// Number of quantizers
    pub num_quantizers: i64,
    /// Number of semantic quantizers
    pub num_semantic_quantizers: i64,
    /// Latent dimension
    pub latent_dim: i64,
    /// Decoder dimension
    pub decoder_dim: i64,
    /// Upsampling ratios for pre-transformer upsample
    pub upsampling_ratios: Vec<i64>,
    /// Upsample rates for decoder blocks
    pub upsample_rates: Vec<i64>,
    /// Hidden size for transformer
    pub hidden_size: i64,
    /// Number of transformer layers
    pub num_hidden_layers: i64,
    /// Number of attention heads
    pub num_attention_heads: i64,
    /// Head dimension
    pub head_dim: i64,
    /// Intermediate size for MLP
    pub intermediate_size: i64,
    /// RMS norm epsilon
    pub rms_norm_eps: f64,
    /// RoPE theta
    pub rope_theta: f64,
    /// Sliding window size for attention
    pub sliding_window: i64,
}

impl Default for VocoderConfig {
    fn default() -> Self {
        Self {
            codebook_dim: 512,
            codebook_size: 2048,
            num_quantizers: 16,
            num_semantic_quantizers: 1,
            latent_dim: 1024,
            decoder_dim: 1536,
            upsampling_ratios: vec![2, 2],
            upsample_rates: vec![8, 5, 4, 3],
            hidden_size: 512,
            num_hidden_layers: 8,
            num_attention_heads: 16,
            head_dim: 64,
            intermediate_size: 1024,
            rms_norm_eps: 1e-5,
            rope_theta: 10000.0,
            sliding_window: 72,
        }
    }
}

/// Euclidean codebook for vector quantization.
pub struct EuclideanCodebook {
    /// Sum of embeddings (codebook_size, dim)
    embedding_sum: Tensor,
    /// Usage count per code (codebook_size,)
    cluster_usage: Tensor,
    /// Dimension
    dim: i64,
    /// Epsilon for numerical stability
    epsilon: f64,
}

impl EuclideanCodebook {
    /// Create a new codebook from weights.
    pub fn from_weights(embedding_sum: Tensor, cluster_usage: Tensor, dim: i64) -> Self {
        Self {
            embedding_sum,
            cluster_usage,
            dim,
            epsilon: 1e-5,
        }
    }

    /// Decode codes to embeddings.
    pub fn decode(&self, codes: &Tensor) -> Tensor {
        // Compute normalized embeddings: embedding_sum / cluster_usage
        let usage = self.cluster_usage.clamp_min(self.epsilon).unsqueeze(-1);
        let embedding = &self.embedding_sum / &usage;

        // Lookup embeddings for codes using F.embedding
        Tensor::embedding(&embedding, &codes.to_dtype(DType::Int64))
    }
}

/// Vector quantization layer with projection.
pub struct VectorQuantization {
    /// Codebook
    codebook: EuclideanCodebook,
    /// Output projection (1x1 conv as linear)
    project_out_weight: Option<Tensor>,
}

impl VectorQuantization {
    /// Create from weights.
    pub fn from_weights(
        weights: &HashMap<String, Tensor>,
        prefix: &str,
        _dim: i64,
        device: Device,
    ) -> Option<Self> {
        let embedding_sum = weights
            .get(&format!("{}_codebook.embedding_sum", prefix))?
            .to_device(device);
        let cluster_usage = weights
            .get(&format!("{}_codebook.cluster_usage", prefix))?
            .to_device(device);

        let codebook_dim = embedding_sum.size()[1];
        let codebook = EuclideanCodebook::from_weights(embedding_sum, cluster_usage, codebook_dim);

        // Project out is a 1x1 conv: [out_dim, in_dim, 1]
        let project_out_weight = weights
            .get(&format!("{}project_out.weight", prefix))
            .map(|w| w.squeeze_dim(-1).to_device(device)); // Remove the kernel dim

        Some(Self {
            codebook,
            project_out_weight,
        })
    }

    /// Decode codes to continuous representation.
    /// codes: [batch, seq_len]
    /// returns: [batch, dim, seq_len]
    pub fn decode(&self, codes: &Tensor) -> Tensor {
        // Get embeddings: [batch, seq_len, codebook_dim]
        let quantized = self.codebook.decode(codes);

        // Apply projection if present: [batch, seq_len, dim]
        let quantized = if let Some(ref proj) = self.project_out_weight {
            // proj is [out_dim, codebook_dim], quantized is [batch, seq_len, codebook_dim]
            quantized.matmul(&proj.transpose(0, 1))
        } else {
            quantized
        };

        // Transpose to [batch, dim, seq_len]
        quantized.transpose(1, 2)
    }
}

/// Residual vector quantization - sum of multiple VQ layers.
pub struct ResidualVectorQuantization {
    /// VQ layers
    layers: Vec<VectorQuantization>,
}

impl ResidualVectorQuantization {
    /// Create from weights.
    pub fn from_weights(
        weights: &HashMap<String, Tensor>,
        prefix: &str,
        num_layers: i64,
        dim: i64,
        device: Device,
    ) -> Option<Self> {
        let mut layers = Vec::new();
        for i in 0..num_layers {
            let layer_prefix = format!("{}layers.{}.", prefix, i);
            if let Some(vq) = VectorQuantization::from_weights(weights, &layer_prefix, dim, device)
            {
                layers.push(vq);
            } else {
                println!("Warning: Failed to load VQ layer {} at {}", i, layer_prefix);
                return None;
            }
        }
        Some(Self { layers })
    }

    /// Decode codes from all layers.
    /// codes: [num_layers, batch, seq_len]
    /// returns: [batch, dim, seq_len]
    pub fn decode(&self, codes: &Tensor) -> Tensor {
        let batch = codes.size()[1];
        let seq_len = codes.size()[2];
        let out_dim = if let Some(layer) = self.layers.first() {
            if let Some(ref proj) = layer.project_out_weight {
                proj.size()[0]
            } else {
                layer.codebook.dim
            }
        } else {
            256
        };

        let mut quantized =
            Tensor::zeros(&[batch, out_dim, seq_len], DType::Float32, codes.device());

        for (idx, layer) in self.layers.iter().enumerate() {
            let layer_codes = codes.select(0, idx as i64);
            quantized += layer.decode(&layer_codes);
        }

        quantized
    }
}

/// Residual vector quantizer with input/output projections.
pub struct ResidualVectorQuantizer {
    /// Input projection (1x1 conv)
    _input_proj_weight: Option<Tensor>,
    /// Output projection (1x1 conv)
    output_proj_weight: Option<Tensor>,
    /// RVQ layers
    vq: ResidualVectorQuantization,
}

impl ResidualVectorQuantizer {
    /// Create from weights.
    pub fn from_weights(
        weights: &HashMap<String, Tensor>,
        prefix: &str,
        n_q: i64,
        dim: i64,
        device: Device,
    ) -> Option<Self> {
        // Load input/output projections (1x1 convs)
        let input_proj_weight = weights
            .get(&format!("{}input_proj.weight", prefix))
            .map(|w| w.squeeze_dim(-1).to_device(device));

        let output_proj_weight = weights
            .get(&format!("{}output_proj.weight", prefix))
            .map(|w| w.squeeze_dim(-1).to_device(device));

        // Load VQ layers
        let vq_prefix = format!("{}vq.", prefix);
        let vq = ResidualVectorQuantization::from_weights(weights, &vq_prefix, n_q, dim, device)?;

        Some(Self {
            _input_proj_weight: input_proj_weight,
            output_proj_weight,
            vq,
        })
    }

    /// Decode codes.
    /// codes: [batch, n_q, seq_len]
    /// returns: [batch, output_dim, seq_len]
    pub fn decode(&self, codes: &Tensor) -> Tensor {
        // Transpose to [n_q, batch, seq_len]
        let codes = codes.transpose(0, 1);

        // Decode through VQ
        let quantized = self.vq.decode(&codes);

        // Apply output projection if present
        if let Some(ref proj) = self.output_proj_weight {
            // quantized is [batch, dim, seq_len]
            // proj is [output_dim, dim]
            // Need 1x1 conv: for each position, proj @ x
            let batch = quantized.size()[0];
            let seq_len = quantized.size()[2];
            let quantized = quantized.transpose(1, 2).contiguous(); // [batch, seq_len, dim]
            let quantized = quantized.view(&[-1, quantized.size()[2]]); // [batch*seq_len, dim]
            let out = quantized.matmul(&proj.transpose(0, 1)); // [batch*seq_len, output_dim]
            out.view(&[batch, seq_len, -1]).transpose(1, 2) // [batch, output_dim, seq_len]
        } else {
            quantized
        }
    }
}

/// Split residual vector quantizer - separate semantic and acoustic quantizers.
pub struct SplitResidualVectorQuantizer {
    /// Semantic RVQ (first n_q_semantic layers)
    rvq_first: ResidualVectorQuantizer,
    /// Acoustic RVQ (remaining layers)
    rvq_rest: ResidualVectorQuantizer,
    /// Number of semantic quantizers
    n_q_semantic: i64,
}

impl SplitResidualVectorQuantizer {
    /// Create from weights.
    pub fn from_weights(
        weights: &HashMap<String, Tensor>,
        prefix: &str,
        n_q: i64,
        n_q_semantic: i64,
        dim: i64,
        device: Device,
    ) -> Option<Self> {
        let rvq_first = ResidualVectorQuantizer::from_weights(
            weights,
            &format!("{}rvq_first.", prefix),
            n_q_semantic,
            dim,
            device,
        )?;

        let rvq_rest = ResidualVectorQuantizer::from_weights(
            weights,
            &format!("{}rvq_rest.", prefix),
            n_q - n_q_semantic,
            dim,
            device,
        )?;

        Some(Self {
            rvq_first,
            rvq_rest,
            n_q_semantic,
        })
    }

    /// Decode codes.
    /// codes: [batch, n_q, seq_len]
    /// returns: [batch, output_dim, seq_len]
    pub fn decode(&self, codes: &Tensor) -> Tensor {
        let semantic_codes = codes.narrow(1, 0, self.n_q_semantic);
        let mut quantized = self.rvq_first.decode(&semantic_codes);

        let n_q = codes.size()[1];
        if n_q > self.n_q_semantic {
            let acoustic_codes = codes.narrow(1, self.n_q_semantic, n_q - self.n_q_semantic);
            quantized += self.rvq_rest.decode(&acoustic_codes);
        }

        quantized
    }
}

/// Causal 1D convolution with proper padding.
pub struct CausalConv1d {
    /// Convolution weight [out_channels, in_channels, kernel_size]
    weight: Tensor,
    /// Convolution bias [out_channels]
    bias: Option<Tensor>,
    /// Stride
    stride: i64,
    /// Dilation
    dilation: i64,
    /// Groups
    groups: i64,
}

/// Streaming state for a causal 1D convolution.
#[derive(Default)]
pub struct CausalConv1dState {
    buffer: Option<Tensor>,
}

impl CausalConv1d {
    /// Create from weights.
    pub fn from_weights(
        weight: Tensor,
        bias: Option<Tensor>,
        stride: i64,
        dilation: i64,
        groups: i64,
    ) -> Self {
        Self {
            weight,
            bias,
            stride,
            dilation,
            groups,
        }
    }

    fn padding(&self, input_channels: i64) -> i64 {
        let weight_shape = self.weight.size();
        let input_channels_per_group = input_channels / self.groups;
        let kernel_size = if weight_shape.len() == 3 && weight_shape[2] == input_channels_per_group
        {
            weight_shape[1]
        } else {
            weight_shape[2]
        };
        let effective_kernel_size = (kernel_size - 1) * self.dilation + 1;
        effective_kernel_size - self.stride
    }

    fn conv(&self, x: &Tensor) -> Tensor {
        x.conv1d(
            &self.weight,
            self.bias.as_ref(),
            &[self.stride],
            &[0],
            &[self.dilation],
            self.groups,
        )
    }

    /// Forward pass with causal padding.
    pub fn forward(&self, x: &Tensor) -> Tensor {
        let padding = self.padding(x.size()[1]);
        let padded = if padding > 0 {
            x.constant_pad_nd(&[padding, 0])
        } else {
            x.shallow_clone()
        };
        self.conv(&padded)
    }

    /// Incremental forward pass matching MLX `CausalConv1d.step`.
    pub fn step(&self, x: &Tensor, state: &mut CausalConv1dState) -> Tensor {
        let padding = self.padding(x.size()[1]);
        let padded = if padding > 0 {
            if let Some(buffer) = &state.buffer {
                Tensor::cat(&[buffer.shallow_clone(), x.shallow_clone()], 2)
            } else {
                x.constant_pad_nd(&[padding, 0])
            }
        } else {
            x.shallow_clone()
        };
        if padding > 0 {
            let length = padded.size()[2];
            state.buffer = Some(padded.narrow(2, length - padding, padding));
        }
        self.conv(&padded)
    }
}

/// Causal transposed 1D convolution for upsampling.
pub struct CausalTransConv1d {
    /// Convolution weight [in_channels, out_channels, kernel_size]
    weight: Tensor,
    /// Convolution bias [out_channels]
    bias: Option<Tensor>,
    /// Stride (upsample factor)
    stride: i64,
    /// Right padding to trim (causal: no left trim)
    right_pad: i64,
}

/// Streaming overlap state for a causal transposed 1D convolution.
#[derive(Default)]
pub struct CausalTransConv1dState {
    overflow: Option<Tensor>,
}

impl CausalTransConv1d {
    /// Create from weights.
    pub fn from_weights(weight: Tensor, bias: Option<Tensor>, stride: i64) -> Self {
        let kernel_size = weight.size()[2];
        let right_pad = kernel_size - stride;

        Self {
            weight,
            bias,
            stride,
            right_pad,
        }
    }

    fn raw_forward(&self, x: &Tensor) -> Tensor {
        x.conv_transpose1d(
            &self.weight,
            self.bias.as_ref(),
            &[self.stride],
            &[0],
            &[0],
            1,
            &[1],
        )
    }

    /// Forward pass with upsampling.
    pub fn forward(&self, x: &Tensor) -> Tensor {
        let out = self.raw_forward(x);
        self.trim_right(out)
    }

    /// Incremental overlap-add step matching MLX `DecoderBlockUpsample.step`.
    pub fn step(&self, x: &Tensor, state: &mut CausalTransConv1dState) -> Tensor {
        let mut out = self.raw_forward(x);
        if let Some(overflow) = &state.overflow {
            let overflow_len = overflow.size()[2];
            let length = out.size()[2];
            if length > overflow_len {
                let merged = out.narrow(2, 0, overflow_len) + overflow;
                let rest = out.narrow(2, overflow_len, length - overflow_len);
                out = Tensor::cat(&[merged, rest], 2);
            } else {
                out += overflow.narrow(2, 0, length);
            }
        }
        if self.right_pad > 0 {
            let length = out.size()[2];
            if length > self.right_pad {
                state.overflow = Some(out.narrow(2, length - self.right_pad, self.right_pad));
                return out.narrow(2, 0, length - self.right_pad);
            }
            state.overflow = Some(out.shallow_clone());
            return Tensor::zeros(&[out.size()[0], out.size()[1], 0], out.kind(), out.device());
        }
        out
    }

    fn trim_right(&self, out: Tensor) -> Tensor {
        let length = out.size()[2];
        if self.right_pad > 0 && length > self.right_pad {
            out.narrow(2, 0, length - self.right_pad)
        } else {
            out
        }
    }
}

// =============================================================================
// Pre-Transformer Components
// =============================================================================

/// RMS Layer Normalization for vocoder transformer.
pub struct VocoderRMSNorm {
    weight: Tensor,
    eps: f64,
}

impl VocoderRMSNorm {
    /// Create from weights.
    pub fn from_weights(weight: Tensor, eps: f64) -> Self {
        Self { weight, eps }
    }

    /// Forward pass.
    pub fn forward(&self, x: &Tensor) -> Tensor {
        let variance = x.pow_scalar(2.0).mean_dim(&[-1], true);
        let x_normed = x * (variance + self.eps).rsqrt();
        &self.weight * x_normed
    }
}

/// Rotary position embeddings for vocoder transformer.
pub struct VocoderRotaryEmbedding {
    inv_freq: Tensor,
    _dim: i64,
}

impl VocoderRotaryEmbedding {
    /// Create new rotary embeddings.
    pub fn new(dim: i64, _max_seq_len: i64, theta: f64, device: Device) -> Self {
        let half_dim = dim / 2;
        let inv_freq: Vec<f32> = (0..half_dim)
            .map(|i| 1.0 / (theta as f32).powf(2.0 * i as f32 / dim as f32))
            .collect();
        let inv_freq = Tensor::from_slice_f32(&inv_freq).to_device(device);

        Self {
            inv_freq,
            _dim: dim,
        }
    }

    /// Compute cos and sin for given sequence length.
    pub fn forward(&self, seq_len: i64, device: Device) -> (Tensor, Tensor) {
        self.forward_with_offset(seq_len, 0, device)
    }

    /// Compute cos and sin for cached incremental decoding positions.
    pub fn forward_with_offset(
        &self,
        seq_len: i64,
        offset: i64,
        device: Device,
    ) -> (Tensor, Tensor) {
        let positions: Vec<f32> = (offset..offset + seq_len).map(|i| i as f32).collect();
        let positions = Tensor::from_slice_f32(&positions)
            .to_device(device)
            .unsqueeze(1);

        let freqs = positions.matmul(&self.inv_freq.unsqueeze(0));
        let emb = Tensor::cat(&[freqs.clone(), freqs], -1);

        (emb.cos(), emb.sin())
    }
}

/// Apply rotary position embeddings to q and k.
fn apply_rotary_pos_emb(q: &Tensor, k: &Tensor, cos: &Tensor, sin: &Tensor) -> (Tensor, Tensor) {
    let rotate_half = |x: &Tensor| {
        let size = x.size();
        let dim = *size.last().unwrap();
        let x1 = x.narrow(-1, 0, dim / 2);
        let x2 = x.narrow(-1, dim / 2, dim / 2);
        Tensor::cat(&[x2.neg(), x1], -1)
    };

    // cos and sin: [seq_len, head_dim]
    // q, k: [batch, num_heads, seq_len, head_dim]
    let cos = cos.unsqueeze(0).unsqueeze(0); // [1, 1, seq_len, head_dim]
    let sin = sin.unsqueeze(0).unsqueeze(0);

    let q_embed = q * &cos + rotate_half(q) * &sin;
    let k_embed = k * &cos + rotate_half(k) * &sin;

    (q_embed, k_embed)
}

/// SwiGLU MLP for vocoder transformer.
pub struct VocoderMLP {
    gate_proj: Tensor,
    up_proj: Tensor,
    down_proj: Tensor,
}

impl VocoderMLP {
    /// Create from weights.
    pub fn from_weights(gate_proj: Tensor, up_proj: Tensor, down_proj: Tensor) -> Self {
        Self {
            gate_proj,
            up_proj,
            down_proj,
        }
    }

    /// Forward pass with SwiGLU activation.
    pub fn forward(&self, x: &Tensor) -> Tensor {
        let gate = x.matmul(&self.gate_proj.transpose(0, 1)).silu();
        let up = x.matmul(&self.up_proj.transpose(0, 1));
        (gate * up).matmul(&self.down_proj.transpose(0, 1))
    }
}

/// Layer scale (learned scalar multiplier).
pub struct VocoderLayerScale {
    scale: Tensor,
}

impl VocoderLayerScale {
    /// Create from weights.
    pub fn from_weights(scale: Tensor) -> Self {
        Self { scale }
    }

    /// Forward pass.
    pub fn forward(&self, x: &Tensor) -> Tensor {
        x * &self.scale
    }
}

/// Self-attention for vocoder transformer.
pub struct VocoderAttention {
    q_proj: Tensor,
    k_proj: Tensor,
    v_proj: Tensor,
    o_proj: Tensor,
    num_heads: i64,
    head_dim: i64,
    scaling: f64,
    #[allow(dead_code)]
    sliding_window: i64,
}

impl VocoderAttention {
    /// Create from weights.
    pub fn from_weights(
        q_proj: Tensor,
        k_proj: Tensor,
        v_proj: Tensor,
        o_proj: Tensor,
        num_heads: i64,
        head_dim: i64,
        sliding_window: i64,
    ) -> Self {
        let scaling = (head_dim as f64).powf(-0.5);
        Self {
            q_proj,
            k_proj,
            v_proj,
            o_proj,
            num_heads,
            head_dim,
            scaling,
            sliding_window,
        }
    }

    /// Forward pass.
    pub fn forward(
        &self,
        hidden_states: &Tensor,
        cos: &Tensor,
        sin: &Tensor,
        attention_mask: Option<&Tensor>,
    ) -> Tensor {
        self.forward_with_cache(hidden_states, cos, sin, attention_mask, None)
    }

    /// Forward pass with optional KV cache, matching MLX decoder attention.
    pub fn forward_with_cache(
        &self,
        hidden_states: &Tensor,
        cos: &Tensor,
        sin: &Tensor,
        attention_mask: Option<&Tensor>,
        cache: Option<&mut KVCache>,
    ) -> Tensor {
        let s = hidden_states.size();
        let batch = s[0];
        let seq_len = s[1];

        let q = hidden_states.matmul(&self.q_proj.transpose(0, 1));
        let k = hidden_states.matmul(&self.k_proj.transpose(0, 1));
        let v = hidden_states.matmul(&self.v_proj.transpose(0, 1));

        let q = q
            .view(&[batch, seq_len, self.num_heads, self.head_dim])
            .transpose(1, 2);
        let k = k
            .view(&[batch, seq_len, self.num_heads, self.head_dim])
            .transpose(1, 2);
        let v = v
            .view(&[batch, seq_len, self.num_heads, self.head_dim])
            .transpose(1, 2);

        let (q, k) = apply_rotary_pos_emb(&q, &k, cos, sin);
        let (k, v) = if let Some(cache) = cache {
            cache.update_and_fetch(k, v)
        } else {
            (k, v)
        };

        #[cfg(feature = "mlx")]
        let attn_output = Tensor::from_mlx(mlx::ops::fast_scaled_dot_product_attention(
            q.as_mlx(),
            k.as_mlx(),
            v.as_mlx(),
            self.scaling as f32,
            attention_mask.map(|mask| mask.as_mlx()),
        ));
        #[cfg(not(feature = "mlx"))]
        let attn_output = {
            let attn_weights = q.matmul(&k.transpose(-2, -1)) * self.scaling;
            let attn_weights = if let Some(mask) = attention_mask {
                attn_weights + mask
            } else {
                attn_weights
            };
            attn_weights.softmax(-1).matmul(&v)
        };

        let attn_output = attn_output
            .transpose(1, 2)
            .contiguous()
            .view(&[batch, seq_len, -1]);
        attn_output.matmul(&self.o_proj.transpose(0, 1))
    }
}

/// Transformer layer for vocoder.
pub struct VocoderTransformerLayer {
    input_layernorm: VocoderRMSNorm,
    self_attn: VocoderAttention,
    self_attn_layer_scale: VocoderLayerScale,
    post_attention_layernorm: VocoderRMSNorm,
    mlp: VocoderMLP,
    mlp_layer_scale: VocoderLayerScale,
}

impl VocoderTransformerLayer {
    /// Load from weights.
    pub fn from_weights(
        weights: &HashMap<String, Tensor>,
        prefix: &str,
        num_heads: i64,
        head_dim: i64,
        sliding_window: i64,
        rms_norm_eps: f64,
        device: Device,
    ) -> Option<Self> {
        let input_layernorm_weight = weights
            .get(&format!("{}.input_layernorm.weight", prefix))?
            .to_device(device);
        let post_attention_layernorm_weight = weights
            .get(&format!("{}.post_attention_layernorm.weight", prefix))?
            .to_device(device);

        let q_proj = weights
            .get(&format!("{}.self_attn.q_proj.weight", prefix))?
            .to_device(device);
        let k_proj = weights
            .get(&format!("{}.self_attn.k_proj.weight", prefix))?
            .to_device(device);
        let v_proj = weights
            .get(&format!("{}.self_attn.v_proj.weight", prefix))?
            .to_device(device);
        let o_proj = weights
            .get(&format!("{}.self_attn.o_proj.weight", prefix))?
            .to_device(device);

        let self_attn_layer_scale = weights
            .get(&format!("{}.self_attn_layer_scale.scale", prefix))?
            .to_device(device);
        let mlp_layer_scale = weights
            .get(&format!("{}.mlp_layer_scale.scale", prefix))?
            .to_device(device);

        let gate_proj = weights
            .get(&format!("{}.mlp.gate_proj.weight", prefix))?
            .to_device(device);
        let up_proj = weights
            .get(&format!("{}.mlp.up_proj.weight", prefix))?
            .to_device(device);
        let down_proj = weights
            .get(&format!("{}.mlp.down_proj.weight", prefix))?
            .to_device(device);

        Some(Self {
            input_layernorm: VocoderRMSNorm::from_weights(input_layernorm_weight, rms_norm_eps),
            self_attn: VocoderAttention::from_weights(
                q_proj,
                k_proj,
                v_proj,
                o_proj,
                num_heads,
                head_dim,
                sliding_window,
            ),
            self_attn_layer_scale: VocoderLayerScale::from_weights(self_attn_layer_scale),
            post_attention_layernorm: VocoderRMSNorm::from_weights(
                post_attention_layernorm_weight,
                rms_norm_eps,
            ),
            mlp: VocoderMLP::from_weights(gate_proj, up_proj, down_proj),
            mlp_layer_scale: VocoderLayerScale::from_weights(mlp_layer_scale),
        })
    }

    /// Forward pass.
    pub fn forward(
        &self,
        hidden_states: &Tensor,
        cos: &Tensor,
        sin: &Tensor,
        attention_mask: Option<&Tensor>,
    ) -> Tensor {
        self.forward_with_cache(hidden_states, cos, sin, attention_mask, None)
    }

    /// Forward pass with optional KV cache.
    pub fn forward_with_cache(
        &self,
        hidden_states: &Tensor,
        cos: &Tensor,
        sin: &Tensor,
        attention_mask: Option<&Tensor>,
        cache: Option<&mut KVCache>,
    ) -> Tensor {
        let residual = hidden_states;

        let hidden_states = self.input_layernorm.forward(hidden_states);
        let hidden_states =
            self.self_attn
                .forward_with_cache(&hidden_states, cos, sin, attention_mask, cache);
        let hidden_states = residual + self.self_attn_layer_scale.forward(&hidden_states);

        let residual = &hidden_states;
        let mlp_out = self.post_attention_layernorm.forward(&hidden_states);
        let mlp_out = self.mlp.forward(&mlp_out);
        residual + self.mlp_layer_scale.forward(&mlp_out)
    }
}

/// Full pre-transformer for vocoder.
pub struct VocoderTransformer {
    input_proj_weight: Tensor,
    input_proj_bias: Tensor,
    layers: Vec<VocoderTransformerLayer>,
    norm: VocoderRMSNorm,
    output_proj_weight: Tensor,
    output_proj_bias: Tensor,
    rotary_emb: VocoderRotaryEmbedding,
}

/// Streaming KV-cache state for the vocoder pre-transformer.
pub struct VocoderTransformerState {
    caches: Vec<KVCache>,
}

impl VocoderTransformerState {
    fn new(num_layers: usize) -> Self {
        Self {
            caches: (0..num_layers).map(|_| KVCache::new()).collect(),
        }
    }
}

impl VocoderTransformer {
    /// Load from weights.
    pub fn load(
        weights: &HashMap<String, Tensor>,
        config: &VocoderConfig,
        device: Device,
    ) -> Result<Self> {
        let input_proj_weight = weights
            .get("decoder.pre_transformer.input_proj.weight")
            .ok_or_else(|| {
                Qwen3TTSError::ModelLoad("Missing pre_transformer input_proj.weight".into())
            })?
            .to_device(device);
        let input_proj_bias = weights
            .get("decoder.pre_transformer.input_proj.bias")
            .ok_or_else(|| {
                Qwen3TTSError::ModelLoad("Missing pre_transformer input_proj.bias".into())
            })?
            .to_device(device);

        let output_proj_weight = weights
            .get("decoder.pre_transformer.output_proj.weight")
            .ok_or_else(|| {
                Qwen3TTSError::ModelLoad("Missing pre_transformer output_proj.weight".into())
            })?
            .to_device(device);
        let output_proj_bias = weights
            .get("decoder.pre_transformer.output_proj.bias")
            .ok_or_else(|| {
                Qwen3TTSError::ModelLoad("Missing pre_transformer output_proj.bias".into())
            })?
            .to_device(device);

        let norm_weight = weights
            .get("decoder.pre_transformer.norm.weight")
            .ok_or_else(|| Qwen3TTSError::ModelLoad("Missing pre_transformer norm.weight".into()))?
            .to_device(device);

        let mut layers = Vec::new();
        for i in 0..config.num_hidden_layers {
            let prefix = format!("decoder.pre_transformer.layers.{}", i);
            let layer = VocoderTransformerLayer::from_weights(
                weights,
                &prefix,
                config.num_attention_heads,
                config.head_dim,
                config.sliding_window,
                config.rms_norm_eps,
                device,
            )
            .ok_or_else(|| {
                Qwen3TTSError::ModelLoad(format!("Failed to load transformer layer {}", i))
            })?;
            layers.push(layer);
        }

        let rotary_emb = VocoderRotaryEmbedding::new(
            config.head_dim,
            8000, // max_position_embeddings
            config.rope_theta,
            device,
        );

        Ok(Self {
            input_proj_weight,
            input_proj_bias,
            layers,
            norm: VocoderRMSNorm::from_weights(norm_weight, config.rms_norm_eps),
            output_proj_weight,
            output_proj_bias,
            rotary_emb,
        })
    }

    /// Forward pass.
    pub fn forward(&self, hidden: &Tensor) -> Tensor {
        self.forward_inner(hidden, None)
    }

    /// Incremental forward pass using a KV cache.
    pub fn step(&self, hidden: &Tensor, state: &mut VocoderTransformerState) -> Tensor {
        self.forward_inner(hidden, Some(state))
    }

    fn forward_inner(
        &self,
        hidden: &Tensor,
        mut state: Option<&mut VocoderTransformerState>,
    ) -> Tensor {
        let hidden = hidden.transpose(1, 2);
        let mut hidden =
            hidden.matmul(&self.input_proj_weight.transpose(0, 1)) + &self.input_proj_bias;

        let seq_len = hidden.size()[1];
        let offset = state
            .as_ref()
            .and_then(|state| state.caches.first())
            .map(|cache| cache.len())
            .unwrap_or(0);
        let (cos, sin) = self
            .rotary_emb
            .forward_with_offset(seq_len, offset, hidden.device());
        let attention_mask = if seq_len > 1 {
            Some(causal_mask(
                seq_len,
                offset + seq_len,
                offset,
                hidden.device(),
            ))
        } else {
            None
        };

        if let Some(state) = state.as_deref_mut() {
            for (layer, cache) in self.layers.iter().zip(state.caches.iter_mut()) {
                hidden = layer.forward_with_cache(
                    &hidden,
                    &cos,
                    &sin,
                    attention_mask.as_ref(),
                    Some(cache),
                );
            }
        } else {
            for layer in &self.layers {
                hidden = layer.forward(&hidden, &cos, &sin, attention_mask.as_ref());
            }
        }

        hidden = self.norm.forward(&hidden);
        let hidden =
            hidden.matmul(&self.output_proj_weight.transpose(0, 1)) + &self.output_proj_bias;
        hidden.transpose(1, 2)
    }
}

fn causal_mask(seq_len: i64, total_len: i64, offset: i64, device: Device) -> Tensor {
    let invalid = Tensor::ones(&[seq_len, total_len], DType::Bool, device).triu(offset + 1);
    Tensor::zeros(&[seq_len, total_len], DType::Float32, device)
        .masked_fill(&invalid, f64::NEG_INFINITY)
        .unsqueeze(0)
        .unsqueeze(0)
}

// =============================================================================
// Decoder Components
// =============================================================================

/// SnakeBeta activation function.
pub struct SnakeBeta {
    /// Alpha parameter (frequency)
    alpha: Tensor,
    /// Beta parameter (magnitude)
    beta: Tensor,
}

impl SnakeBeta {
    /// Create from weights.
    pub fn from_weights(alpha: Tensor, beta: Tensor) -> Self {
        Self { alpha, beta }
    }

    /// Forward pass.
    pub fn forward(&self, x: &Tensor) -> Tensor {
        let alpha = self.alpha.exp().unsqueeze(0).unsqueeze(-1);
        let beta = self.beta.exp().unsqueeze(0).unsqueeze(-1);
        let sin_term = (x * &alpha).sin();
        x + (&sin_term * &sin_term) / (beta + 1e-9)
    }
}

/// ConvNeXt block for upsample stages.
pub struct ConvNeXtBlock {
    /// Depth-wise convolution
    dwconv: CausalConv1d,
    /// Layer norm weight
    norm_weight: Tensor,
    /// Layer norm bias
    norm_bias: Tensor,
    /// First pointwise conv weight
    pwconv1_weight: Tensor,
    /// First pointwise conv bias
    pwconv1_bias: Tensor,
    /// Second pointwise conv weight
    pwconv2_weight: Tensor,
    /// Second pointwise conv bias
    pwconv2_bias: Tensor,
    /// Gamma scale
    gamma: Tensor,
    /// Dimension
    dim: i64,
}

/// Streaming state for a ConvNeXt block.
#[derive(Default)]
pub struct ConvNeXtBlockState {
    dwconv: CausalConv1dState,
}

impl ConvNeXtBlock {
    /// Create from weights.
    pub fn from_weights(
        weights: &HashMap<String, Tensor>,
        prefix: &str,
        dim: i64,
        device: Device,
    ) -> Option<Self> {
        let dwconv_weight = weights
            .get(&format!("{}dwconv.conv.weight", prefix))?
            .to_device(device);
        let dwconv_bias = weights
            .get(&format!("{}dwconv.conv.bias", prefix))
            .map(|w| w.to_device(device));
        let dwconv = CausalConv1d::from_weights(dwconv_weight, dwconv_bias, 1, 1, dim);

        let norm_weight = weights
            .get(&format!("{}norm.weight", prefix))?
            .to_device(device);
        let norm_bias = weights
            .get(&format!("{}norm.bias", prefix))?
            .to_device(device);

        let pwconv1_weight = weights
            .get(&format!("{}pwconv1.weight", prefix))?
            .to_device(device);
        let pwconv1_bias = weights
            .get(&format!("{}pwconv1.bias", prefix))?
            .to_device(device);

        let pwconv2_weight = weights
            .get(&format!("{}pwconv2.weight", prefix))?
            .to_device(device);
        let pwconv2_bias = weights
            .get(&format!("{}pwconv2.bias", prefix))?
            .to_device(device);

        let gamma = weights.get(&format!("{}gamma", prefix))?.to_device(device);

        Some(Self {
            dwconv,
            norm_weight,
            norm_bias,
            pwconv1_weight,
            pwconv1_bias,
            pwconv2_weight,
            pwconv2_bias,
            gamma,
            dim,
        })
    }

    /// Forward pass.
    pub fn forward(&self, x: &Tensor) -> Tensor {
        self.forward_inner(x, None)
    }

    /// Incremental forward pass matching MLX `ConvNeXtBlock.step`.
    pub fn step(&self, x: &Tensor, state: &mut ConvNeXtBlockState) -> Tensor {
        self.forward_inner(x, Some(&mut state.dwconv))
    }

    fn forward_inner(&self, x: &Tensor, conv_state: Option<&mut CausalConv1dState>) -> Tensor {
        let residual = x;
        let hidden = if let Some(conv_state) = conv_state {
            self.dwconv.step(x, conv_state)
        } else {
            self.dwconv.forward(x)
        };
        let hidden = hidden.transpose(1, 2);
        let hidden = hidden.layer_norm(
            &[self.dim],
            Some(&self.norm_weight),
            Some(&self.norm_bias),
            1e-6,
        );
        let hidden = hidden.matmul(&self.pwconv1_weight.transpose(0, 1)) + &self.pwconv1_bias;
        let hidden = hidden.gelu();
        let hidden = hidden.matmul(&self.pwconv2_weight.transpose(0, 1)) + &self.pwconv2_bias;
        let hidden = &self.gamma * hidden;
        let hidden = hidden.transpose(1, 2);
        residual + hidden
    }
}

/// Decoder residual unit with SnakeBeta activations.
pub struct DecoderResidualUnit {
    act1: SnakeBeta,
    conv1: CausalConv1d,
    act2: SnakeBeta,
    conv2: CausalConv1d,
}

/// Streaming state for a decoder residual unit.
#[derive(Default)]
pub struct DecoderResidualUnitState {
    conv1: CausalConv1dState,
    conv2: CausalConv1dState,
}

impl DecoderResidualUnit {
    /// Create from weights.
    pub fn from_weights(
        weights: &HashMap<String, Tensor>,
        prefix: &str,
        dilation: i64,
        device: Device,
    ) -> Option<Self> {
        let act1_alpha = weights
            .get(&format!("{}act1.alpha", prefix))?
            .to_device(device);
        let act1_beta = weights
            .get(&format!("{}act1.beta", prefix))?
            .to_device(device);
        let act1 = SnakeBeta::from_weights(act1_alpha, act1_beta);

        let conv1_weight = weights
            .get(&format!("{}conv1.conv.weight", prefix))?
            .to_device(device);
        let conv1_bias = weights
            .get(&format!("{}conv1.conv.bias", prefix))
            .map(|w| w.to_device(device));
        let conv1 = CausalConv1d::from_weights(conv1_weight, conv1_bias, 1, dilation, 1);

        let act2_alpha = weights
            .get(&format!("{}act2.alpha", prefix))?
            .to_device(device);
        let act2_beta = weights
            .get(&format!("{}act2.beta", prefix))?
            .to_device(device);
        let act2 = SnakeBeta::from_weights(act2_alpha, act2_beta);

        let conv2_weight = weights
            .get(&format!("{}conv2.conv.weight", prefix))?
            .to_device(device);
        let conv2_bias = weights
            .get(&format!("{}conv2.conv.bias", prefix))
            .map(|w| w.to_device(device));
        let conv2 = CausalConv1d::from_weights(conv2_weight, conv2_bias, 1, 1, 1);

        Some(Self {
            act1,
            conv1,
            act2,
            conv2,
        })
    }

    /// Forward pass.
    pub fn forward(&self, x: &Tensor) -> Tensor {
        self.forward_inner(x, None)
    }

    /// Incremental forward pass matching MLX `DecoderResidualUnit.step`.
    pub fn step(&self, x: &Tensor, state: &mut DecoderResidualUnitState) -> Tensor {
        self.forward_inner(x, Some(state))
    }

    fn forward_inner(&self, x: &Tensor, state: Option<&mut DecoderResidualUnitState>) -> Tensor {
        let residual = x;
        let hidden = self.act1.forward(x);
        let hidden = if let Some(state) = state {
            let hidden = self.conv1.step(&hidden, &mut state.conv1);
            let hidden = self.act2.forward(&hidden);
            self.conv2.step(&hidden, &mut state.conv2)
        } else {
            let hidden = self.conv1.forward(&hidden);
            let hidden = self.act2.forward(&hidden);
            self.conv2.forward(&hidden)
        };
        residual + hidden
    }
}

/// Decoder block with upsampling and residual units.
pub struct DecoderBlock {
    snake: SnakeBeta,
    trans_conv: CausalTransConv1d,
    residual_units: Vec<DecoderResidualUnit>,
}

/// Streaming state for a decoder block.
pub struct DecoderBlockState {
    trans_conv: CausalTransConv1dState,
    residual_units: Vec<DecoderResidualUnitState>,
}

impl DecoderBlockState {
    fn new(num_residual_units: usize) -> Self {
        Self {
            trans_conv: CausalTransConv1dState::default(),
            residual_units: (0..num_residual_units)
                .map(|_| DecoderResidualUnitState::default())
                .collect(),
        }
    }
}

impl DecoderBlock {
    /// Create from weights.
    pub fn from_weights(
        weights: &HashMap<String, Tensor>,
        prefix: &str,
        upsample_rate: i64,
        device: Device,
    ) -> Option<Self> {
        let snake_alpha = weights
            .get(&format!("{}block.0.alpha", prefix))?
            .to_device(device);
        let snake_beta = weights
            .get(&format!("{}block.0.beta", prefix))?
            .to_device(device);
        let snake = SnakeBeta::from_weights(snake_alpha, snake_beta);

        let trans_weight = weights
            .get(&format!("{}block.1.conv.weight", prefix))?
            .to_device(device);
        let trans_bias = weights
            .get(&format!("{}block.1.conv.bias", prefix))
            .map(|w| w.to_device(device));
        let trans_conv = CausalTransConv1d::from_weights(trans_weight, trans_bias, upsample_rate);

        let dilations = [1, 3, 9];
        let mut residual_units = Vec::new();
        for (i, &dilation) in dilations.iter().enumerate() {
            let unit_prefix = format!("{}block.{}.", prefix, i + 2);
            if let Some(unit) =
                DecoderResidualUnit::from_weights(weights, &unit_prefix, dilation, device)
            {
                residual_units.push(unit);
            } else {
                return None;
            }
        }

        Some(Self {
            snake,
            trans_conv,
            residual_units,
        })
    }

    /// Forward pass.
    pub fn forward(&self, x: &Tensor) -> Tensor {
        let hidden = self.snake.forward(x);
        let mut hidden = self.trans_conv.forward(&hidden);
        for unit in &self.residual_units {
            hidden = unit.forward(&hidden);
        }
        hidden
    }

    /// Incremental forward pass matching MLX `DecoderBlock.step`.
    pub fn step(&self, x: &Tensor, state: &mut DecoderBlockState) -> Tensor {
        let hidden = self.snake.forward(x);
        let mut hidden = self.trans_conv.step(&hidden, &mut state.trans_conv);
        for (unit, unit_state) in self
            .residual_units
            .iter()
            .zip(state.residual_units.iter_mut())
        {
            hidden = unit.step(&hidden, unit_state);
        }
        hidden
    }
}

/// Complete vocoder decoder for 12Hz model.
pub struct Vocoder {
    /// Split residual vector quantizer
    quantizer: SplitResidualVectorQuantizer,
    /// Pre-conv layer (codebook_dim -> latent_dim)
    pre_conv: CausalConv1d,
    /// Pre-transformer (8-layer transformer)
    pre_transformer: VocoderTransformer,
    /// Upsample blocks (transconv + convnext)
    upsample_blocks: Vec<(CausalTransConv1d, ConvNeXtBlock)>,
    /// First decoder conv (latent_dim -> decoder_dim)
    decoder_first_conv: CausalConv1d,
    /// Main decoder blocks
    decoder_blocks: Vec<DecoderBlock>,
    /// Final SnakeBeta activation
    final_snake: SnakeBeta,
    /// Final convolution
    final_conv: CausalConv1d,
    /// Configuration
    #[allow(dead_code)]
    config: VocoderConfig,
}

/// Full streaming state for incremental vocoder decoding.
pub struct VocoderStreamingState {
    pre_conv: CausalConv1dState,
    pre_transformer: VocoderTransformerState,
    upsample_convnext: Vec<ConvNeXtBlockState>,
    decoder_first_conv: CausalConv1dState,
    decoder_blocks: Vec<DecoderBlockState>,
    final_conv: CausalConv1dState,
}

impl Vocoder {
    /// Load vocoder from weights.
    pub fn load(
        weights: &HashMap<String, Tensor>,
        config: VocoderConfig,
        device: Device,
    ) -> Result<Self> {
        println!("Loading Vocoder...");

        // Load quantizer with "decoder." prefix
        let quantizer = SplitResidualVectorQuantizer::from_weights(
            weights,
            "decoder.quantizer.",
            config.num_quantizers,
            config.num_semantic_quantizers,
            config.codebook_dim / 2, // dimension is half codebook_dim
            device,
        )
        .ok_or_else(|| Qwen3TTSError::ModelLoad("Failed to load quantizer".into()))?;
        println!("  Loaded quantizer");

        // Load pre_conv
        let pre_conv_weight = weights
            .get("decoder.pre_conv.conv.weight")
            .ok_or_else(|| Qwen3TTSError::ModelLoad("Missing decoder.pre_conv.conv.weight".into()))?
            .to_device(device);
        let pre_conv_bias = weights
            .get("decoder.pre_conv.conv.bias")
            .map(|w| w.to_device(device));
        let pre_conv = CausalConv1d::from_weights(pre_conv_weight, pre_conv_bias, 1, 1, 1);
        println!("  Loaded pre_conv");

        // Load full pre-transformer (8 layers)
        let pre_transformer = VocoderTransformer::load(weights, &config, device)?;
        println!(
            "  Loaded pre_transformer ({} layers)",
            config.num_hidden_layers
        );

        // Load upsample blocks
        let mut upsample_blocks = Vec::new();
        for (i, &factor) in config.upsampling_ratios.iter().enumerate() {
            let trans_weight = weights
                .get(&format!("decoder.upsample.{}.0.conv.weight", i))
                .ok_or_else(|| Qwen3TTSError::ModelLoad(format!("Missing upsample.{}.0", i)))?
                .to_device(device);
            let trans_bias = weights
                .get(&format!("decoder.upsample.{}.0.conv.bias", i))
                .map(|w| w.to_device(device));
            let trans_conv = CausalTransConv1d::from_weights(trans_weight, trans_bias, factor);

            let convnext = ConvNeXtBlock::from_weights(
                weights,
                &format!("decoder.upsample.{}.1.", i),
                config.latent_dim,
                device,
            )
            .ok_or_else(|| Qwen3TTSError::ModelLoad(format!("Failed to load upsample.{}.1", i)))?;

            upsample_blocks.push((trans_conv, convnext));
        }
        println!("  Loaded {} upsample blocks", upsample_blocks.len());

        // Load first decoder conv
        let first_conv_weight = weights
            .get("decoder.decoder.0.conv.weight")
            .ok_or_else(|| Qwen3TTSError::ModelLoad("Missing decoder.decoder.0".into()))?
            .to_device(device);
        let first_conv_bias = weights
            .get("decoder.decoder.0.conv.bias")
            .map(|w| w.to_device(device));
        let decoder_first_conv =
            CausalConv1d::from_weights(first_conv_weight, first_conv_bias, 1, 1, 1);
        println!("  Loaded decoder first conv");

        // Load decoder blocks
        let mut decoder_blocks = Vec::new();
        for (i, &upsample_rate) in config.upsample_rates.iter().enumerate() {
            let block = DecoderBlock::from_weights(
                weights,
                &format!("decoder.decoder.{}.", i + 1),
                upsample_rate,
                device,
            )
            .ok_or_else(|| Qwen3TTSError::ModelLoad(format!("Failed to load decoder.{}", i + 1)))?;
            decoder_blocks.push(block);
        }
        println!("  Loaded {} decoder blocks", decoder_blocks.len());

        // Load final activation and conv
        let final_idx = config.upsample_rates.len() + 1;
        let final_snake_alpha = weights
            .get(&format!("decoder.decoder.{}.alpha", final_idx))
            .ok_or_else(|| Qwen3TTSError::ModelLoad("Missing final snake alpha".into()))?
            .to_device(device);
        let final_snake_beta = weights
            .get(&format!("decoder.decoder.{}.beta", final_idx))
            .ok_or_else(|| Qwen3TTSError::ModelLoad("Missing final snake beta".into()))?
            .to_device(device);
        let final_snake = SnakeBeta::from_weights(final_snake_alpha, final_snake_beta);

        let final_conv_weight = weights
            .get(&format!("decoder.decoder.{}.conv.weight", final_idx + 1))
            .ok_or_else(|| Qwen3TTSError::ModelLoad("Missing final conv weight".into()))?
            .to_device(device);
        let final_conv_bias = weights
            .get(&format!("decoder.decoder.{}.conv.bias", final_idx + 1))
            .map(|w| w.to_device(device));
        let final_conv = CausalConv1d::from_weights(final_conv_weight, final_conv_bias, 1, 1, 1);
        println!("  Loaded final layers");

        Ok(Self {
            quantizer,
            pre_conv,
            pre_transformer,
            upsample_blocks,
            decoder_first_conv,
            decoder_blocks,
            final_snake,
            final_conv,
            config,
        })
    }

    /// Create fresh streaming state for one utterance.
    pub fn streaming_state(&self) -> VocoderStreamingState {
        VocoderStreamingState {
            pre_conv: CausalConv1dState::default(),
            pre_transformer: VocoderTransformerState::new(self.pre_transformer.layers.len()),
            upsample_convnext: self
                .upsample_blocks
                .iter()
                .map(|_| ConvNeXtBlockState::default())
                .collect(),
            decoder_first_conv: CausalConv1dState::default(),
            decoder_blocks: self
                .decoder_blocks
                .iter()
                .map(|block| DecoderBlockState::new(block.residual_units.len()))
                .collect(),
            final_conv: CausalConv1dState::default(),
        }
    }

    /// Decode audio codes to waveform.
    /// codes: [batch, num_quantizers, seq_len]
    /// returns: [batch, samples]
    pub fn decode(&self, codes: &Tensor) -> Tensor {
        let hidden = self.quantizer.decode(codes);
        let hidden = self.pre_conv.forward(&hidden);
        let mut hidden = self.pre_transformer.forward(&hidden);

        for (trans_conv, convnext) in &self.upsample_blocks {
            hidden = trans_conv.forward(&hidden);
            hidden = convnext.forward(&hidden);
        }

        hidden = self.decoder_first_conv.forward(&hidden);
        for block in &self.decoder_blocks {
            hidden = block.forward(&hidden);
        }

        hidden = self.final_snake.forward(&hidden);
        hidden = self.final_conv.forward(&hidden);
        hidden.clamp(-1.0, 1.0).squeeze_dim(1)
    }

    /// Decode audio codes to waveform while writing coarse vocoder parity traces.
    pub fn decode_with_trace(&self, codes: &Tensor, trace: &mut TraceWriter) -> Result<Tensor> {
        let hidden = self.quantizer.decode(codes);
        trace.tensor("vocoder/quantizer/combined", &hidden)?;
        let hidden = self.pre_conv.forward(&hidden);
        trace.tensor("vocoder/pre_conv", &hidden)?;
        let mut hidden = self.pre_transformer.forward(&hidden);
        trace.tensor("vocoder/pre_transformer/output", &hidden)?;

        for (index, (trans_conv, convnext)) in self.upsample_blocks.iter().enumerate() {
            hidden = trans_conv.forward(&hidden);
            trace.tensor(&format!("vocoder/upsample_{index:02}/trans_conv"), &hidden)?;
            hidden = convnext.forward(&hidden);
            trace.tensor(&format!("vocoder/upsample_{index:02}/convnext"), &hidden)?;
        }

        hidden = self.decoder_first_conv.forward(&hidden);
        trace.tensor("vocoder/decoder/first_conv", &hidden)?;
        for (index, block) in self.decoder_blocks.iter().enumerate() {
            hidden = block.forward(&hidden);
            trace.tensor(&format!("vocoder/decoder/block_{index:02}"), &hidden)?;
        }

        hidden = self.final_snake.forward(&hidden);
        trace.tensor("vocoder/decoder/final_snake", &hidden)?;
        hidden = self.final_conv.forward(&hidden);
        let waveform = hidden.clamp(-1.0, 1.0).squeeze_dim(1);
        trace.tensor("vocoder/waveform", &waveform)?;
        Ok(waveform)
    }

    /// Incrementally decode only new code frames, matching MLX `decoder.streaming_step`.
    pub fn decode_streaming(&self, codes: &Tensor, state: &mut VocoderStreamingState) -> Tensor {
        let hidden = self.quantizer.decode(codes);
        let hidden = self.pre_conv.step(&hidden, &mut state.pre_conv);
        let mut hidden = self
            .pre_transformer
            .step(&hidden, &mut state.pre_transformer);

        for ((trans_conv, convnext), convnext_state) in self
            .upsample_blocks
            .iter()
            .zip(state.upsample_convnext.iter_mut())
        {
            hidden = trans_conv.forward(&hidden);
            hidden = convnext.step(&hidden, convnext_state);
        }

        hidden = self
            .decoder_first_conv
            .step(&hidden, &mut state.decoder_first_conv);
        for (block, block_state) in self
            .decoder_blocks
            .iter()
            .zip(state.decoder_blocks.iter_mut())
        {
            hidden = block.step(&hidden, block_state);
        }

        hidden = self.final_snake.forward(&hidden);
        hidden = self.final_conv.step(&hidden, &mut state.final_conv);
        hidden.clamp(-1.0, 1.0).squeeze_dim(1)
    }
}

/// Load vocoder weights from safetensors file.
pub fn load_vocoder_weights<P: AsRef<std::path::Path>>(
    path: P,
    device: Device,
) -> Result<HashMap<String, Tensor>> {
    let path = path.as_ref();
    if !path.exists() {
        return Err(Qwen3TTSError::ModelLoad(format!(
            "Vocoder weights file not found: {}",
            path.display()
        )));
    }

    let tensors = Tensor::load_safetensors(path)?;

    let mut weights = HashMap::new();
    for (name, tensor) in tensors {
        weights.insert(name, tensor.to_device(device));
    }

    println!("Loaded {} vocoder weight tensors", weights.len());
    Ok(weights)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vocoder_config_default() {
        let config = VocoderConfig::default();
        assert_eq!(config.num_quantizers, 16);
        assert_eq!(config.codebook_size, 2048);
    }
}
