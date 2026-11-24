export class LoginThrottle {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly options: {
      windowMs?: number;
      maxAttempts?: number;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private windowMs(): number {
    return this.options.windowMs ?? 15 * 60 * 1000;
  }

  private maxAttempts(): number {
    return this.options.maxAttempts ?? 10;
  }

  private prune(key: string): number[] {
    const cutoff = this.now() - this.windowMs();
    const list = (this.attempts.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (list.length === 0) this.attempts.delete(key);
    else this.attempts.set(key, list);
    return list;
  }

  isBlocked(key: string): boolean {
    return this.prune(key).length >= this.maxAttempts();
  }

  fail(key: string): void {
    const list = this.prune(key);
    list.push(this.now());
    this.attempts.set(key, list);
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  clear(): void {
    this.attempts.clear();
  }
}
