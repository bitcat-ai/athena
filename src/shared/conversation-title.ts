export function conversationTitle(text: string) {
  const line = text.trim().split('\n')[0];
  let end = 32;
  for (const match of line.matchAll(/https?:\/\/[^\s<>]+/g)) {
    if (match.index < end && match.index + match[0].length > end)
      end = match.index + match[0].length;
  }
  return line.slice(0, end);
}
