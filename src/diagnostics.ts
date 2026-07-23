const MAX_DIAGNOSTIC_BYTES = 8 * 1024;

/**
 * 有界、脱敏的 CLI 诊断收集器；不保存完整 stdout/stderr。
 * Bounded, redacted CLI diagnostic collector; never stores complete stdout/stderr.
 */
export class RedactedDiagnostics {
  private acceptedBytes = 0;
  private truncated = false;
  private text = '';
  private pending = '';
  private readonly secretBytes: Buffer[];
  private readonly boundaryLength: number;

  constructor(private readonly replacements: readonly string[], secrets: readonly string[] = []) {
    this.secretBytes = secrets.filter(Boolean).map((secret) => Buffer.from(secret, 'utf8'));
    this.boundaryLength = Math.max(0, ...replacements.map((value) => value.length), ...secrets.map((value) => value.length));
  }

  consume(chunk: Buffer | string): void {
    if (this.acceptedBytes >= MAX_DIAGNOSTIC_BYTES) {
      this.truncated = true;
      return;
    }

    const combined = this.pending + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    const splitAt = Math.max(0, combined.length - this.boundaryLength);
    this.pending = combined.slice(splitAt);
    this.appendSafe(combined.slice(0, splitAt));
  }

  private appendSafe(text: string): void {
    if (!text || this.acceptedBytes >= MAX_DIAGNOSTIC_BYTES) {
      return;
    }

    let safeText = text;
    for (const secret of this.secretBytes) {
      safeText = safeText.replaceAll(secret.toString('utf8'), '<redacted-password>');
    }
    for (const replacement of this.replacements) {
      if (replacement) {
        safeText = safeText.replaceAll(replacement, '<redacted-path>');
      }
    }

    const remaining = MAX_DIAGNOSTIC_BYTES - this.acceptedBytes;
    const accepted = Buffer.from(safeText, 'utf8').subarray(0, remaining).toString('utf8');
    this.text += accepted;
    this.acceptedBytes += Buffer.byteLength(accepted, 'utf8');
    this.truncated ||= Buffer.byteLength(safeText, 'utf8') > remaining;
  }

  summary(): { text: string; acceptedBytes: number; truncated: boolean } {
    this.appendSafe(this.pending);
    this.pending = '';
    return { text: this.text, acceptedBytes: this.acceptedBytes, truncated: this.truncated };
  }
}

/** 返回不含原始输出的用户级诊断摘要。 / Return a user-level diagnostic summary without raw output. */
export function safeDiagnosticMessage(diagnostics: RedactedDiagnostics): string {
  const summary = diagnostics.summary();
  const suffix = summary.truncated ? '（诊断已截断）' : '';
  return `CLI 已返回错误${suffix}。`;
}
