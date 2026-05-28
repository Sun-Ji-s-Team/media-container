export interface ImageProcessRequest {
  /** Input image URLs or base64 data */
  images: string[];
  /** Output format: png, jpeg, webp, avif */
  format?: "png" | "jpeg" | "webp" | "avif";
  /** Quality 1-100 (jpeg/webp/avif only) */
  quality?: number;
  /** Max width */
  width?: number;
  /** Max height */
  height?: number;
  /** Fit mode */
  fit?: "cover" | "contain" | "fill" | "inside" | "outside";
}

export interface StitchImageRequest {
  images: string[];
  /** Layout direction */
  direction: "horizontal" | "vertical" | "grid";
  /** Grid columns (grid mode only) */
  columns?: number;
  /** Gap between images in pixels */
  gap?: number;
  /** Background color (CSS string) */
  background?: string;
  format?: "png" | "jpeg" | "webp";
  quality?: number;
}

export interface RemoveBgRequest {
  image: string;
  format?: "png" | "webp";
}

export interface VideoProcessRequest {
  /** Input video URLs */
  videos: string[];
  /** Output format */
  format?: "mp4" | "webm" | "mov";
  /** CRF quality (0-51, lower = better, default 23) */
  crf?: number;
  /** Max width */
  width?: number;
  /** Max height */
  height?: number;
}

export interface FrameExtractRequest {
  video: string;
  /** Which frames to extract */
  frames: "first" | "last" | "both";
  /** Output image format */
  format?: "png" | "jpeg" | "webp";
  /** Image quality */
  quality?: number;
  /** Max width */
  width?: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ProcessedImage {
  data: Buffer;
  format: string;
  width: number;
  height: number;
  size: number;
}
