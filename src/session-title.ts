import type { TextMessage } from './types.js';

export function formatSessionTitle(value: string | undefined): string | undefined {
  const firstLine = value?.trim().split(/\r?\n/, 1)[0]?.trim();
  return firstLine ? firstLine.slice(0, 80) : undefined;
}

export function formatNativeSessionTitle(value: string | undefined): string | undefined {
  const title = value?.replace(/\s+/g, ' ').trim();
  return title || undefined;
}

export function titleFromMessages(messages: readonly TextMessage[]): string | undefined {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.text.trim());
  return formatSessionTitle(firstUserMessage?.text);
}
