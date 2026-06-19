use rten::Model;
use rten_tensor::prelude::*;
use rten_tensor::NdTensor;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: probe_encoder <model.rten> [wav]");
    let model = Model::load_file(&path)?;
    for (kind, ids) in [("input", model.input_ids()), ("output", model.output_ids())] {
        for &id in ids {
            let info = model.node_info(id);
            println!(
                "{kind}: name={:?} shape={:?} dtype={:?}",
                info.as_ref().and_then(|i| i.name()),
                info.as_ref().and_then(|i| i.shape()),
                info.as_ref().and_then(|i| i.dtype()),
            );
        }
    }

    let window = 16_000 * 20;
    let mut samples = vec![0.0f32; window];
    let mut real_len = 16_000 * 2;
    if let Some(wav_path) = std::env::args().nth(2) {
        // Real speech reference: decode, downmix, resample to 16 kHz.
        let mut reader = hound::WavReader::open(&wav_path)?;
        let spec = reader.spec();
        let raw: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap()).collect(),
            hound::SampleFormat::Int => reader
                .samples::<i16>()
                .map(|s| s.unwrap() as f32 / 32768.0)
                .collect(),
        };
        let mono: Vec<f32> = raw
            .chunks(spec.channels as usize)
            .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
            .collect();
        let resampled = neutts::codec::resample(&mono, spec.sample_rate, 16_000);
        real_len = resampled.len().min(window);
        samples[..real_len].copy_from_slice(&resampled[..real_len]);
        println!("loaded {wav_path}: {real_len} samples at 16 kHz ({:.2}s)", real_len as f32 / 16_000.0);
    } else {
        // 2-second 220Hz sine in a 20s zero-padded window, 16 kHz mono.
        for (i, s) in samples.iter_mut().enumerate().take(real_len) {
            *s = (i as f32 * 220.0 * 2.0 * std::f32::consts::PI / 16_000.0).sin() * 0.5;
        }
    }
    println!("expected codes for real audio: {}", real_len.div_ceil(320));
    let input = NdTensor::from_data([1usize, 1, window], samples);
    let started = std::time::Instant::now();
    let output = model.run_one(input.into(), None)?;
    println!("ran in {:?}; output: {:?}", started.elapsed(), output.dtype());
    match output {
        rten::Value::Int32Tensor(t) => {
            let shape = t.shape().to_vec();
            let v: Vec<i32> = t.to_vec();
            println!("i32 shape={:?} first20={:?}", shape, &v[..20.min(v.len())]);
        }
        other => println!("other value: dtype={:?}", other.dtype()),
    }
    Ok(())
}
