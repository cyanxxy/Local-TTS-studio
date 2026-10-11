//! Which tensor provider and device Qwen3 runs on. The decision is made once
//! per process from what the compiled provider reports.

use std::sync::OnceLock;

use qwen3_tts_rs::tensor::Device;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompiledProvider {
    #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
    Mlx,
    #[cfg(any(all(target_os = "windows", target_arch = "x86_64"), test))]
    LibTorch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeTarget {
    pub provider: &'static str,
    pub device: &'static str,
    pub accelerated: bool,
    tensor_device: Device,
}

fn select_runtime_target(provider: CompiledProvider, accelerator_available: bool) -> RuntimeTarget {
    match (provider, accelerator_available) {
        #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
        (CompiledProvider::Mlx, true) => RuntimeTarget {
            provider: "mlx",
            device: "metal",
            accelerated: true,
            tensor_device: Device::Gpu(0),
        },
        #[cfg(any(all(target_os = "windows", target_arch = "x86_64"), test))]
        (CompiledProvider::LibTorch, true) => RuntimeTarget {
            provider: "libtorch",
            device: "cuda",
            accelerated: true,
            tensor_device: Device::Gpu(0),
        },
        #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
        (CompiledProvider::Mlx, false) => RuntimeTarget {
            provider: "mlx",
            device: "cpu",
            accelerated: false,
            tensor_device: Device::Cpu,
        },
        #[cfg(any(all(target_os = "windows", target_arch = "x86_64"), test))]
        (CompiledProvider::LibTorch, false) => RuntimeTarget {
            provider: "libtorch",
            device: "cpu",
            accelerated: false,
            tensor_device: Device::Cpu,
        },
    }
}

fn detect_runtime_target() -> RuntimeTarget {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let mut metal_available = false;
        unsafe {
            qwen3_tts_rs::backend::mlx::ffi::mlx_metal_is_available(&mut metal_available);
        }
        select_runtime_target(CompiledProvider::Mlx, metal_available)
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        select_runtime_target(CompiledProvider::LibTorch, tch::Cuda::is_available())
    }
}

pub fn resolved_runtime_target() -> RuntimeTarget {
    static TARGET: OnceLock<RuntimeTarget> = OnceLock::new();
    *TARGET.get_or_init(detect_runtime_target)
}

pub fn inference_device() -> Device {
    let target = resolved_runtime_target();
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        qwen3_tts_rs::backend::mlx::stream::init_mlx(target.accelerated);
    }
    target.tensor_device
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_target_selection_tracks_backend_and_accelerator_availability() {
        let mlx_gpu = select_runtime_target(CompiledProvider::Mlx, true);
        assert_eq!(mlx_gpu.provider, "mlx");
        assert_eq!(mlx_gpu.device, "metal");
        assert!(mlx_gpu.accelerated);
        assert_eq!(mlx_gpu.tensor_device, Device::Gpu(0));

        let mlx_cpu = select_runtime_target(CompiledProvider::Mlx, false);
        assert_eq!(mlx_cpu.provider, "mlx");
        assert_eq!(mlx_cpu.device, "cpu");
        assert!(!mlx_cpu.accelerated);
        assert_eq!(mlx_cpu.tensor_device, Device::Cpu);

        let libtorch_gpu = select_runtime_target(CompiledProvider::LibTorch, true);
        assert_eq!(libtorch_gpu.provider, "libtorch");
        assert_eq!(libtorch_gpu.device, "cuda");
        assert!(libtorch_gpu.accelerated);
        assert_eq!(libtorch_gpu.tensor_device, Device::Gpu(0));

        let libtorch_cpu = select_runtime_target(CompiledProvider::LibTorch, false);
        assert_eq!(libtorch_cpu.provider, "libtorch");
        assert_eq!(libtorch_cpu.device, "cpu");
        assert!(!libtorch_cpu.accelerated);
        assert_eq!(libtorch_cpu.tensor_device, Device::Cpu);
    }
}
