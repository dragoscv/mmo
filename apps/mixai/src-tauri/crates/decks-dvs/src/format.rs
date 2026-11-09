//! Timecode formats and what this crate supports for each.

/// How far a mode is supported for a format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Support {
    /// Implemented and verified by the crate's tests.
    Supported,
    /// Implemented from public descriptions, verified only on synthetic signals so far.
    Experimental,
    /// Not implemented; the reason is the missing public (non-GPL) information.
    Pending(&'static str),
}

/// A timecode format (control vinyl / CD family).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TimecodeFormat {
    /// Our own MixAI timecode: 1 kHz quadrature carrier, 20-bit LFSR, amplitude-modulated bits.
    MixAi,
    /// Serato Control Vinyl CV02.5 / Control CD: 1 kHz quadrature carrier (public description).
    SeratoCv25,
    /// Traktor Control Vinyl MK2: 2.5 kHz offset-modulated quadrature carrier (public description).
    TraktorMk2,
    /// Phase (MWM) audio mode: no public signal description found.
    Phase,
    /// Any other quadrature carrier.
    Custom {
        /// Carrier frequency in Hz at nominal speed.
        carrier_hz: f32,
        /// Differentiate the input first (offset-modulated carriers).
        differentiate: bool,
    },
}

const SERATO_ABS: &str =
    "Serato LFSR polynomial/seed not derivable from public non-GPL sources; relative only";
const TRAKTOR_ABS: &str =
    "Traktor MK2 110-bit code has no public non-GPL characterisation; relative only";
const PHASE_PENDING: &str =
    "pending vendor docs: Phase audio-mode signal is not publicly documented";
const CUSTOM_ABS: &str = "plug a PositionCode with DvsDecoder::with_code";

impl TimecodeFormat {
    /// Human-readable name.
    pub fn name(&self) -> &'static str {
        match self {
            Self::MixAi => "MixAI",
            Self::SeratoCv25 => "Serato CV02.5",
            Self::TraktorMk2 => "Traktor MK2",
            Self::Phase => "Phase",
            Self::Custom { .. } => "Custom",
        }
    }

    /// Carrier frequency at nominal speed (None when unknown).
    pub fn carrier_hz(&self) -> Option<f32> {
        match self {
            Self::MixAi | Self::SeratoCv25 => Some(1000.0),
            Self::TraktorMk2 => Some(2500.0),
            Self::Phase => None,
            Self::Custom { carrier_hz, .. } => Some(*carrier_hz),
        }
    }

    /// Whether the front-end differentiates the input before phase tracking.
    pub fn differentiate(&self) -> bool {
        match self {
            Self::TraktorMk2 => true,
            Self::Custom { differentiate, .. } => *differentiate,
            _ => false,
        }
    }

    /// Relative-mode (speed + direction) support.
    pub fn relative_support(&self) -> Support {
        match self {
            Self::MixAi => Support::Supported,
            Self::SeratoCv25 | Self::TraktorMk2 | Self::Custom { .. } => Support::Experimental,
            Self::Phase => Support::Pending(PHASE_PENDING),
        }
    }

    /// Absolute-mode (needle position) support.
    pub fn absolute_support(&self) -> Support {
        match self {
            Self::MixAi => Support::Supported,
            Self::SeratoCv25 => Support::Pending(SERATO_ABS),
            Self::TraktorMk2 => Support::Pending(TRAKTOR_ABS),
            Self::Phase => Support::Pending(PHASE_PENDING),
            Self::Custom { .. } => Support::Pending(CUSTOM_ABS),
        }
    }
}
