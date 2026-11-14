/** Clean accumulated PTY output for text observations, not screen emulation. */
export function cleanTerminalOutput(text: string): string {
  // Stop at the first BEL or ST: a later OSC in a differential repaint must
  // never consume visible status text that was written between the sequences.
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[=>]/g, "");
}
