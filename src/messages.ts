export interface TextMessage {
  role: string;
  content: string;
}

function sanitizeSessionTitle(title: string): string {
  return title
    .replace(/#token=[^\s]+/gi, '#token=[redacted]')
    .replace(/([?&]token=)[^&\s]+/gi, '$1[redacted]');
}

function redactToken(value: string, token: string | undefined): string {
  if (!token || token.length === 0) return value;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(escaped, 'g'), '[redacted]');
}

export function sanitizeDiagnosticText(value: string, token?: string): string {
  return redactToken(sanitizeSessionTitle(value), token);
}

export function isInternalMessage(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith('<system-reminder>') ||
    trimmed.includes('<plugin_session_start') ||
    trimmed.includes('Kimi Code tool mapping for Superpowers skills') ||
    trimmed.includes('Auto permission mode is active')
  );
}

export function selectLatestMeaningfulMessage(
  messages: readonly TextMessage[],
  role: string,
  token?: string,
  truncateAt?: number,
): string | undefined {
  for (const message of messages) {
    if (message.role !== role) continue;
    const trimmed = message.content.trim();
    if (trimmed.length === 0) continue;
    if (isInternalMessage(trimmed)) continue;
    const sanitized = sanitizeDiagnosticText(trimmed, token);
    if (truncateAt !== undefined && sanitized.length > truncateAt) {
      return `${sanitized.slice(0, truncateAt)}...`;
    }
    return sanitized;
  }
  return undefined;
}
