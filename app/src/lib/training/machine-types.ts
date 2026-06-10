/**
 * Map a Vertex accelerator type to its required machine type.
 * Each accelerator is fused to a specific machine family on Vertex AI.
 */
export function machineTypeForAccelerator(acc: string): string {
    switch (acc) {
        case "NVIDIA_A100_80GB":
            return "a2-ultragpu-1g";
        case "NVIDIA_A100_40GB":
        case "NVIDIA_TESLA_A100":
            return "a2-highgpu-1g";
        case "NVIDIA_L4":
            return "g2-standard-12";
        case "NVIDIA_TESLA_T4":
        case "NVIDIA_TESLA_V100":
        case "NVIDIA_TESLA_P100":
        case "NVIDIA_TESLA_P4":
            return "n1-standard-8";
        case "NVIDIA_H100_80GB":
            return "a3-highgpu-1g";
        default:
            return "n1-standard-8";
    }
}
