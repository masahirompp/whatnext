import {HookStore} from '../../lib/input/hooks.js';

// ダイジェストの受け口(DESIGN.md「ダイジェストの受信」)。mod は今の受け口の `/v1/hooks` に、`hook_event_name` が
// `WhatnextDigest` の本文を送る。本文はダイジェストと会話リンクを並べて運ぶ(会話リンクはダイジェストの一部ではない)。
// lib の受け口はフックの本文を `HookStore.receiveHook` に渡すので、その手前でこの本文だけを抜き取り、ほかはそのまま
// lib に渡す(lib の契約を変えずに口を足す)。

export interface Digest {
  goal: string;
  progress: string;
  next: string;
}

export interface ConversationLink {
  label: string;
  href: string;
}

/** あるセッションから最後に受けた、ダイジェストと会話リンク(並べて持つ。会話リンクはダイジェストに含めない)。 */
export interface DigestAndLinks {
  digest?: Digest;
  links: ConversationLink[];
  /** 受け取った時刻。 */
  at: number;
}

export const DIGEST_EVENT = 'WhatnextDigest';
/** 受けるリンクの数の上限(mod が送るのは 20 件)。 */
const MAX_LINKS = 20;
const MAX = {goal: 200, progress: 400, next: 300, label: 200, href: 2048};

/** 制御文字(改行とタブを含む)を除き、長さを切る。受け口にはローカルのどのプロセスからも送れるので、描く前に落とす。 */
export function sanitize(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  let out = '';
  for (const ch of s.replace(/[\r\n\t]+/g, ' ')) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) continue;
    out += ch;
  }
  out = out.trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** 本文からダイジェストと会話リンクを読む。mod の本文でなければ undefined。 */
export function parseDigestBody(body: unknown, now: number): {sid: string; received: DigestAndLinks} | undefined {
  let v: unknown = body;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (o.hook_event_name !== DIGEST_EVENT) return undefined;
  const sid = typeof o.session_id === 'string' ? o.session_id : '';
  if (!sid) return undefined;
  let digest: Digest | undefined;
  if (o.digest && typeof o.digest === 'object') {
    const r = o.digest as Record<string, unknown>;
    const x = {
      goal: sanitize(r.goal, MAX.goal),
      progress: sanitize(r.progress, MAX.progress),
      next: sanitize(r.next, MAX.next),
    };
    if (x.goal || x.progress || x.next) digest = x;
  }
  const links: ConversationLink[] = [];
  if (Array.isArray(o.links)) {
    for (const l of o.links.slice(0, MAX_LINKS)) {
      if (!l || typeof l !== 'object') continue;
      const href = sanitize((l as Record<string, unknown>).href, MAX.href);
      // 開くのは http(s) の URL だけ(`open` にほかの形を渡さない)
      if (!/^https?:\/\/[^\s]+$/.test(href)) continue;
      links.push({href, label: sanitize((l as Record<string, unknown>).label, MAX.label) || href});
    }
  }
  return {sid, received: {digest, links, at: now}};
}

/**
 * フックの値に加えて、ダイジェストと会話リンクをセッションごとにメモリに持つ。受けるのは、ダイジェストが有効なときだけ。
 * 受けないときは、mod の本文を捨てる(lib にも渡さない)。
 */
export class DigestHookStore extends HookStore {
  private digestAndLinks = new Map<string, DigestAndLinks>();

  constructor(
    private readonly enabled: boolean,
    private readonly clock: () => number = Date.now,
  ) {
    super();
  }

  override receiveHook(body: unknown): void {
    const r = parseDigestBody(body, this.clock());
    if (r) {
      if (!this.enabled) return;
      // ダイジェストが作れなかった回(リンクだけ届いた)は、前のダイジェストを残す
      const prev = this.digestAndLinks.get(r.sid);
      this.digestAndLinks.set(r.sid, {...r.received, digest: r.received.digest ?? prev?.digest});
      return;
    }
    if (isDigestLike(body)) return;
    super.receiveHook(body);
  }

  /** そのセッションの最後に受けたダイジェストと会話リンク。 */
  digestAndLinksOf(sid: string): DigestAndLinks | undefined {
    return this.digestAndLinks.get(sid);
  }

  /** 今のダイジェストと会話リンクの写し(更新の時点の値を一覧に渡す)。 */
  snapshot(): Map<string, DigestAndLinks> {
    return new Map(this.digestAndLinks);
  }

  override forget(keep: ReadonlySet<string>): void {
    super.forget(keep);
    for (const k of [...this.digestAndLinks.keys()]) if (!keep.has(k)) this.digestAndLinks.delete(k);
  }
}

/** 形の崩れた mod の本文(セッションの ID がないなど)。lib のフックの扱いに渡さない。 */
function isDigestLike(body: unknown): boolean {
  if (typeof body === 'string') return body.includes(DIGEST_EVENT);
  return !!body && typeof body === 'object' && (body as Record<string, unknown>).hook_event_name === DIGEST_EVENT;
}
