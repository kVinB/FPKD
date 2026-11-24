export interface BuildVersionOptions {
  cwd?: string;
  date?: Date;
  override?: string;
}

export function computeBuildVersion(options?: BuildVersionOptions): string;
