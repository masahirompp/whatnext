/** Where the session stands, in three short lines a person reads at a glance. */
export type Digest = {goal: string; progress: string; next: string} | null;

/** A conversation link (GLOSSARY.md): a URL said in the conversation, listed in the pane to open. Not part of the digest. */
export type ConversationLink = {
  /** What two mentions of one page share: a GitHub issue or PR however its URL went on. */
  key: string;
  href: string;
  /** PR, Issue, Commit, or URL for any other page. */
  kind: 'PR' | 'Issue' | 'Commit' | 'URL';
  /** owner/repo#51, or the host and path. */
  label: string;
  /** The words of the Markdown link it was said in (`[PR #58](…)`), drawn in place of `label`. */
  text?: string;
  /** When it was last said, as an ascending count: the newest first. */
  seen: number;
};

declare module 'claude-code' {
  interface PluginState {
    'whatnext-digest': {digest: Shaped<Digest>; links: Shaped<ConversationLink[]>};
  }
}
