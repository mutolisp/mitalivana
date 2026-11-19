/**
 * Web stand-in for mobile/app/src/lib/exportSize.ts. The shared progress
 * overlay only needs `formatBytes` (copied verbatim); the size estimate reads
 * the photo library through bundleExport, which the web app does not have.
 */
export type SizeEstimate = { totalBytes: number; photoBytes: number; textBytes: number; photoCount: number; recordCount: number };

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
