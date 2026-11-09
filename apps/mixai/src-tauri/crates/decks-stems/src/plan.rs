//! Where stems come from: cache, on-device model, or the MMO Server (WP19-09 "server fallback").

use crate::StemKind;

/// Inputs the background queue knows before separating a track.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SourcePlan {
    /// A complete set is already in the local cache.
    pub cached: bool,
    /// The ONNX model file + runtime library are installed on this device.
    pub model_installed: bool,
    /// A hardware accelerator EP registered (DirectML / CoreML / NNAPI); CPU-only is slow on phones.
    pub accelerated: bool,
    /// Device is on battery below the user's threshold or thermally throttled.
    pub constrained: bool,
    /// The track came from a paired MMO Server that reports stems for it.
    pub server_has_stems: bool,
    /// The paired server can separate on request (`/library/analyze` with stems).
    pub server_can_separate: bool,
    /// The user forced on-device processing (privacy setting).
    pub device_only: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StemSource {
    Cache,
    Device,
    /// Download `vocals|drums|bass|other.wav` from the server.
    ServerDownload,
    /// Ask the server to separate, then download.
    ServerSeparate,
    /// Nothing can produce stems now; the UI shows why.
    Unavailable,
}

/// Decision order: cache → server copy (free) → accelerated device → server separation →
/// CPU device (only when not constrained) → unavailable. `device_only` never touches the server.
pub fn plan_source(p: SourcePlan) -> StemSource {
    if p.cached {
        return StemSource::Cache;
    }
    if p.device_only {
        return if p.model_installed && !(p.constrained && !p.accelerated) {
            StemSource::Device
        } else {
            StemSource::Unavailable
        };
    }
    if p.server_has_stems {
        return StemSource::ServerDownload;
    }
    if p.model_installed && p.accelerated && !p.constrained {
        return StemSource::Device;
    }
    if p.server_can_separate {
        return StemSource::ServerSeparate;
    }
    if p.model_installed && !p.constrained {
        return StemSource::Device;
    }
    StemSource::Unavailable
}

/// MMO Server route for one stem (`GET /stems/:trackId/<name>.wav`, see server/src/library/routes.ts).
pub fn server_stem_path(track_id: u64, kind: StemKind) -> String {
    format!("/stems/{track_id}/{}.wav", kind.file_name())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_always_wins() {
        let p = SourcePlan {
            cached: true,
            device_only: true,
            ..Default::default()
        };
        assert_eq!(plan_source(p), StemSource::Cache);
    }

    #[test]
    fn server_copy_beats_recomputing() {
        let p = SourcePlan {
            model_installed: true,
            accelerated: true,
            server_has_stems: true,
            ..Default::default()
        };
        assert_eq!(plan_source(p), StemSource::ServerDownload);
    }

    #[test]
    fn accelerated_device_beats_server_separation() {
        let p = SourcePlan {
            model_installed: true,
            accelerated: true,
            server_can_separate: true,
            ..Default::default()
        };
        assert_eq!(plan_source(p), StemSource::Device);
    }

    #[test]
    fn cpu_only_prefers_the_server() {
        let p = SourcePlan {
            model_installed: true,
            server_can_separate: true,
            ..Default::default()
        };
        assert_eq!(plan_source(p), StemSource::ServerSeparate);
        let alone = SourcePlan {
            model_installed: true,
            ..Default::default()
        };
        assert_eq!(plan_source(alone), StemSource::Device);
    }

    #[test]
    fn constrained_cpu_device_waits() {
        let p = SourcePlan {
            model_installed: true,
            constrained: true,
            ..Default::default()
        };
        assert_eq!(plan_source(p), StemSource::Unavailable);
        let acc = SourcePlan {
            model_installed: true,
            accelerated: true,
            constrained: true,
            device_only: true,
            ..Default::default()
        };
        assert_eq!(plan_source(acc), StemSource::Device);
    }

    #[test]
    fn device_only_never_uses_the_server() {
        let p = SourcePlan {
            server_has_stems: true,
            server_can_separate: true,
            device_only: true,
            ..Default::default()
        };
        assert_eq!(plan_source(p), StemSource::Unavailable);
    }

    #[test]
    fn server_paths_match_the_express_route() {
        assert_eq!(
            server_stem_path(42, StemKind::Vocals),
            "/stems/42/vocals.wav"
        );
        assert_eq!(server_stem_path(7, StemKind::Other), "/stems/7/other.wav");
    }
}
