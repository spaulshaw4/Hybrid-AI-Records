/**
 * Logo resolution / quality checker.
 *
 * Share banners are composited from the crest artwork, so any source smaller
 * than the target box has to be upscaled — which is where the soft edges and
 * halo artifacts come from. These helpers grade a source image against every
 * banner target before it ever reaches the generator.
 */

export type BannerTarget = {
  key: string;
  label: string;
  width: number;
  height: number;
  /**
   * Fraction of the banner's shorter side the crest is expected to occupy in
   * the composite (the generator centres it with padding around the edges).
   */
  crestCoverage: number;
};

/** The banner boxes produced from the crest, largest master first. */
export const BANNER_TARGETS: BannerTarget[] = [
  { key: "master", label: "Master 2400×1260", width: 2400, height: 1260, crestCoverage: 0.86 },
  { key: "hd", label: "HD 1920×1080", width: 1920, height: 1080, crestCoverage: 0.86 },
  { key: "wide", label: "Open Graph 1200×630", width: 1200, height: 630, crestCoverage: 0.86 },
  { key: "square", label: "Square 1080×1080", width: 1080, height: 1080, crestCoverage: 0.82 },
];

export type QualityGrade = "excellent" | "good" | "risky" | "poor";

export type TargetVerdict = {
  target: BannerTarget;
  /** Pixels of crest the composite needs on its longest edge. */
  requiredPx: number;
  /** How much the source must be enlarged: >1 means upscaling. */
  scale: number;
  grade: QualityGrade;
  message: string;
};

export type LogoQualityReport = {
  width: number;
  height: number;
  megapixels: number;
  aspectRatio: number;
  /** Worst grade across all banner targets. */
  overall: QualityGrade;
  verdicts: TargetVerdict[];
  /** Smallest source size that clears every target without upscaling. */
  recommendedMinPx: number;
  warnings: string[];
};

export const GRADE_LABEL: Record<QualityGrade, string> = {
  excellent: "Excellent",
  good: "Good",
  risky: "Upscaling risk",
  poor: "Too small",
};

const GRADE_ORDER: QualityGrade[] = ["excellent", "good", "risky", "poor"];

function gradeForScale(scale: number): QualityGrade {
  if (scale <= 0.75) return "excellent";
  if (scale <= 1) return "good";
  if (scale <= 1.35) return "risky";
  return "poor";
}

function messageForScale(scale: number, requiredPx: number): string {
  if (scale <= 1) {
    return `Source is ${Math.round((1 / scale) * 100) / 100}× larger than the ${requiredPx}px it needs — renders 1:1 or downsamples cleanly.`;
  }
  if (scale <= 1.35) {
    return `Needs ${scale.toFixed(2)}× enlargement to reach ${requiredPx}px — expect slightly soft edges on the crest lettering.`;
  }
  return `Needs ${scale.toFixed(2)}× enlargement to reach ${requiredPx}px — visible upscaling artifacts, halos and mushy text.`;
}

/** Grades a source image's pixel dimensions against every banner target. */
export function analyzeLogoQuality(width: number, height: number): LogoQualityReport {
  const longestSource = Math.max(width, height);

  const verdicts: TargetVerdict[] = BANNER_TARGETS.map((target) => {
    const requiredPx = Math.round(Math.min(target.width, target.height) * target.crestCoverage);
    const scale = requiredPx / longestSource;
    return {
      target,
      requiredPx,
      scale,
      grade: gradeForScale(scale),
      message: messageForScale(scale, requiredPx),
    };
  });

  const overall = verdicts.reduce<QualityGrade>(
    (worst, v) => (GRADE_ORDER.indexOf(v.grade) > GRADE_ORDER.indexOf(worst) ? v.grade : worst),
    "excellent",
  );

  const recommendedMinPx = Math.max(...verdicts.map((v) => v.requiredPx));

  const warnings: string[] = [];
  if (longestSource < recommendedMinPx) {
    warnings.push(
      `Longest edge is ${longestSource}px but the master banner needs ${recommendedMinPx}px. Re-export the crest at ${Math.ceil(recommendedMinPx / 100) * 100}px or larger.`,
    );
  }
  const ratio = width / height;
  if (ratio < 0.7 || ratio > 1.45) {
    warnings.push(
      `Aspect ratio ${ratio.toFixed(2)}:1 is far from the roughly square crest — the composite will letterbox and waste resolution.`,
    );
  }
  if (width * height < 500_000) {
    warnings.push("Under 0.5 megapixels total — too little detail for the crest lettering to survive any resize.");
  }

  return {
    width,
    height,
    megapixels: Math.round(((width * height) / 1_000_000) * 100) / 100,
    aspectRatio: Math.round(ratio * 100) / 100,
    overall,
    verdicts,
    recommendedMinPx,
    warnings,
  };
}

/** Reads the intrinsic pixel size of a browser-selected image file. */
export function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file could not be read as an image."));
    };
    img.src = url;
  });
}
