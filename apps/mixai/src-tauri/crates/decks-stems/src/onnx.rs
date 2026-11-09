//! HT-Demucs v4 through ONNX Runtime (`load-dynamic`: the app ships the platform runtime library).

use std::path::Path;

use ort::ep::ExecutionProviderDispatch;
use ort::session::Session;
use ort::value::Tensor;

use crate::separate::SegmentModel;
use crate::{Result, StemsError};

/// HT-Demucs ONNX export (StemSplit, MIT): input `mix (1, 2, 343980)`, output `stems (1, 4, 2, 343980)`.
pub const HTDEMUCS_RATE: u32 = 44_100;
pub const HTDEMUCS_SEGMENT: usize = 343_980;

/// Accelerators this build can register, best first. CPU is always last.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionTarget {
    DirectMl,
    CoreMl,
    Nnapi,
    Xnnpack,
    Cpu,
}

impl ExecutionTarget {
    pub fn is_accelerated(self) -> bool {
        !matches!(self, ExecutionTarget::Cpu | ExecutionTarget::Xnnpack)
    }

    fn dispatch(self) -> ExecutionProviderDispatch {
        match self {
            #[cfg(target_os = "windows")]
            ExecutionTarget::DirectMl => ort::ep::DirectML::default().build(),
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            ExecutionTarget::CoreMl => ort::ep::CoreML::default().build(),
            #[cfg(target_os = "android")]
            ExecutionTarget::Nnapi => ort::ep::NNAPI::default().build(),
            #[cfg(target_os = "android")]
            ExecutionTarget::Xnnpack => ort::ep::XNNPACK::default().build(),
            _ => ort::ep::CPU::default().build(),
        }
    }
}

/// Targets compiled into this binary for the current OS, best first.
pub fn available_targets() -> Vec<ExecutionTarget> {
    let mut v = Vec::new();
    if cfg!(target_os = "windows") {
        v.push(ExecutionTarget::DirectMl);
    }
    if cfg!(any(target_os = "macos", target_os = "ios")) {
        v.push(ExecutionTarget::CoreMl);
    }
    if cfg!(target_os = "android") {
        v.push(ExecutionTarget::Nnapi);
        v.push(ExecutionTarget::Xnnpack);
    }
    v.push(ExecutionTarget::Cpu);
    v
}

/// One loaded HT-Demucs session.
pub struct OnnxSeparator {
    session: Session,
    input: String,
    output: String,
    targets: Vec<ExecutionTarget>,
}

impl OnnxSeparator {
    /// Load `model` with ONNX Runtime from `runtime_lib` (`onnxruntime.dll` / `libonnxruntime.so|.dylib`).
    /// `targets` empty = [`available_targets`]. ONNX Runtime falls back to CPU for unsupported nodes.
    pub fn load(runtime_lib: &Path, model: &Path, targets: &[ExecutionTarget]) -> Result<Self> {
        let env = ort::init_from(runtime_lib)
            .map_err(|e| StemsError::Model(format!("load {}: {e}", runtime_lib.display())))?
            .with_name("mixai-decks-stems")
            .build()
            .map_err(|e| StemsError::Model(e.to_string()))?;
        let targets = if targets.is_empty() {
            available_targets()
        } else {
            targets.to_vec()
        };
        let eps: Vec<ExecutionProviderDispatch> = targets.iter().map(|t| t.dispatch()).collect();
        let mut builder = Session::builder(&env)
            .map_err(|e| StemsError::Model(e.to_string()))?
            .with_execution_providers(eps)
            .map_err(|e| StemsError::Model(e.to_string()))?;
        let session = builder
            .commit_from_file(model)
            .map_err(|e| StemsError::Model(e.to_string()))?;
        let input = session
            .inputs()
            .first()
            .map(|o| o.name().to_string())
            .unwrap_or_else(|| "mix".into());
        let output = session
            .outputs()
            .first()
            .map(|o| o.name().to_string())
            .unwrap_or_else(|| "stems".into());
        Ok(Self {
            session,
            input,
            output,
            targets,
        })
    }

    /// Targets requested at load time (ONNX Runtime may still have placed nodes on CPU).
    pub fn targets(&self) -> &[ExecutionTarget] {
        &self.targets
    }

    pub fn accelerated(&self) -> bool {
        self.targets.iter().any(|t| t.is_accelerated())
    }
}

impl SegmentModel for OnnxSeparator {
    fn sample_rate(&self) -> u32 {
        HTDEMUCS_RATE
    }

    fn segment_frames(&self) -> usize {
        HTDEMUCS_SEGMENT
    }

    fn run(&mut self, mix: &[f32]) -> Result<Vec<f32>> {
        let tensor = Tensor::from_array((
            [1usize, 2, HTDEMUCS_SEGMENT],
            mix.to_vec().into_boxed_slice(),
        ))
        .map_err(|e| StemsError::Model(e.to_string()))?;
        let outputs = self
            .session
            .run(ort::inputs![self.input.as_str() => tensor])
            .map_err(|e| StemsError::Model(e.to_string()))?;
        let (_, data) = outputs[self.output.as_str()]
            .try_extract_tensor::<f32>()
            .map_err(|e| StemsError::Model(e.to_string()))?;
        Ok(data.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_is_always_the_last_target() {
        let t = available_targets();
        assert_eq!(t.last(), Some(&ExecutionTarget::Cpu));
        #[cfg(target_os = "windows")]
        assert_eq!(t[0], ExecutionTarget::DirectMl);
        #[cfg(target_os = "macos")]
        assert_eq!(t[0], ExecutionTarget::CoreMl);
    }

    #[test]
    fn missing_runtime_library_is_a_clean_error() {
        let r = OnnxSeparator::load(
            Path::new("definitely-missing-onnxruntime.dll"),
            Path::new("x.onnx"),
            &[],
        );
        assert!(matches!(r, Err(StemsError::Model(_))));
    }
}
