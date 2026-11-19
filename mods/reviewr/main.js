import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, ScrollHandle } from "gpui-base";
import { spaces, panes, agents, focused, exec, readTextFile, watchFolder, theme, settings, props, run, notify, nextCommand, checking, closeOverlay, shared, setShared } from "herdr";

const ROW = 20;
const MAX_LINES = 1500;
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const HELP = [
  ["j k ↑ ↓", "move"], ["PgUp PgDn", "page"], ["ctrl-u ctrl-d", "half page"], ["] [", "next / previous change"],
  ["f F", "next / previous file"], ["u b", "scope: uncommitted / branch"], ["B", "pick the branch scope's base"],
  ["v", "select lines"], ["c", "comment"], ["e d", "edit / delete the comment"], ["n N", "next / previous comment"],
  ["l", "list comments"], ["s S", "send to the agent / pick the agent"], ["y Y", "copy the review"],
  ["w", "wrap lines"], ["z", "hide / show the file list"], ["o", "open the pull request"], ["r", "refresh"],
  ["q Q", "close / close and drop comments"], ["?", "these keys"],
];

const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((raw) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) { old = +hunk[1]; next = +hunk[2]; return { kind: "@", raw, text: raw }; }
    const kind = raw[0], text = untab(raw.slice(1)) || " ";
    if (kind === "-") return { kind, raw, text, old: old++ };
    if (kind === "+") return { kind, raw, text, new: next++ };
    if (kind === " ") return { kind, raw, text, old: old++, new: next++ };
    return { kind: "", raw, text: raw };
  });
}

const selectable = (row) => row && (row.kind === "+" || row.kind === "-" || row.kind === " ");

function anchorOf(rows) {
  const lines = rows.filter(selectable);
  if (!lines.length) return null;
  const removedOnly = lines.every((r) => r.kind === "-");
  const numbers = lines.filter((r) => removedOnly || r.kind !== "-").map((r) => removedOnly ? r.old : r.new);
  return { side: removedOnly ? "old" : "new", start: Math.min(...numbers), end: Math.max(...numbers), lines: lines.map((r) => r.raw).join("\n") };
}

function location(c) {
  const range = c.start === c.end ? `${c.file}:${c.start}` : `${c.file}:${c.start}-${c.end}`;
  return c.side === "old" ? `${range} (removed)` : range;
}

function formatReview(root, comments) {
  const sorted = [...comments].sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
  const blocks = sorted.map((c) => `${location(c)}\n${c.lines}\n${c.text.replace(/\r/g, "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).join("\n")}`);
  return [`Worktree: ${root}`, ...blocks].join("\n\n");
}

export default class Reviewr extends View {
  init(_props, cx) {
    if (props()?.overlay) { this.toggler = true; if (!checking()) this.toggle(); return; }
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    const scope = props()?.scope ?? shared("reviewr.scope");
    this.scope = scope === "branch" ? "branch" : "uncommitted";
    this.files = []; this.rows = []; this.view = []; this.comments = []; this.nextId = 1;
    this.cursor = -1; this.anchor = null; this.diffWidth = 300; this.listing = false; this.listIndex = 0;
    this.input = InputState.new({ placeholder: "Comment, Enter saves, Esc cancels" });
    this.input.on("submit", (_e, cx) => this.saveComment(cx));
    this.resolveTarget();
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(15000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        else if (command.endsWith("send")) this.send(cx);
        else if (command.endsWith("refresh")) this.refresh(cx);
        else if (command.startsWith("key-")) this.press(command.slice(4), cx);
        cx.notify();
      }
    });
  }

  toggle() {
    const f = focused();
    const mine = panes().filter((p) => p.mod === "reviewr" && p.tab === f?.tab);
    closeOverlay(props().overlay);
    if (mine.length) for (const p of mine) run("pane.close", { pane: p.pane });
    else run("pane.split", { direction: "right", mod: "reviewr", ...(f?.pane ? { pane: f.pane } : {}) });
  }

  closePane() {
    const own = panes().find((p) => p.mod === "reviewr" && p.focused)
      ?? panes().find((p) => p.mod === "reviewr" && p.tab === this.tab);
    if (own) run("pane.close", { pane: own.pane });
  }

  press(keystroke, cx) {
    const parts = keystroke.split("-"), key = parts[parts.length - 1];
    const plain = parts.length === 1;
    const named = ["escape", "enter", "up", "down", "pageup", "pagedown"].includes(key);
    const event = { keystroke, key: plain && !named ? key.toLowerCase() : key, key_char: plain && !named ? key : undefined, modifiers: {} };
    const proxy = Object.create(cx);
    proxy.stop_propagation = () => {};
    this.onKey(event, proxy);
  }

  resolveTarget() {
    const given = props() ?? {};
    const f = focused();
    this.tab = given.tab ?? f?.tab ?? null;
    const inTab = panes().filter((p) => p.tab === this.tab && p.terminal);
    const pick = inTab.find((p) => p.status) ?? inTab.find((p) => p.focused) ?? inTab[0];
    this.cwd = given.folder ?? pick?.cwd ?? f?.cwd ?? spaces().find((s) => s.active)?.folder ?? null;
    const space = spaces().find((s) => s.tabs?.some?.((t) => (t.id ?? t) === this.tab)) ?? spaces().find((s) => s.active);
    this.space = space?.id ?? null;
    this.on = given.on ?? space?.machine ?? null;
  }

  git(args) { return exec("git", [...READ, ...args], { cwd: this.root, on: this.on }); }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root && !this.typing) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  async base() {
    if (this.scope === "uncommitted") {
      const head = await this.git(["rev-parse", "--verify", "HEAD"]);
      return head.code === 0 ? "HEAD" : null;
    }
    if (this.baseOverride) {
      const picked = await this.git(["merge-base", "HEAD", this.baseOverride]);
      if (picked.code === 0) { this.baseLabel = this.baseOverride; return picked.stdout.trim(); }
      this.baseOverride = null;
    }
    const remote = await this.git(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
    const candidates = [remote.code === 0 ? remote.stdout.trim() : null, "origin/main", "origin/master", "main", "master"].filter(Boolean);
    for (const ref of candidates) {
      const mb = await this.git(["merge-base", "HEAD", ref]);
      if (mb.code === 0) { this.baseLabel = ref; return mb.stdout.trim(); }
    }
    throw new Error("No base branch found (origin/HEAD, main or master)");
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.cwd) throw new Error("No folder: open reviewr from a tab with a terminal in a git repo");
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.cwd, on: this.on });
        if (top.code !== 0) throw new Error(`Not a git repository: ${this.cwd}`);
        const root = top.stdout.trim();
        if (root !== this.root) { this.root = root; this.loadComments(); }
        this.baseRef = await this.base();
        const stats = {};
        const numstat = await this.git(["diff", ...(this.baseRef ? [this.baseRef] : ["--cached"]), "--numstat", "-z", "--no-renames"]);
        if (numstat.code !== 0) throw new Error(numstat.stderr);
        for (const entry of numstat.stdout.split("\0")) {
          const [a, d, ...parts] = entry.split("\t");
          if (!parts.length) continue;
          stats[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
        }
        const status = await this.git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        const untracked = status.stdout.split("\0").filter((e) => e.startsWith("??")).map((e) => e.slice(3));
        const files = Object.entries(stats).map(([path, s]) => ({ path, ...s, fresh: false }));
        for (const path of untracked) if (!stats[path]) files.push({ path, add: 0, del: 0, fresh: true });
        files.sort((a, b) => a.path.localeCompare(b.path));
        this.files = files.slice(0, 1000);
        this.error = null;
        this.watch(root, cx);
        if (this.open && !this.files.some((f) => f.path === this.open)) this.open = null;
        if (!this.open && this.files.length) this.open = this.files[0].path;
        await this.load(this.open);
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path) {
    const file = this.files.find((f) => f.path === path);
    if (!file) { this.setRows([]); return; }
    let lines;
    if (file.fresh) {
      const text = await readTextFile(`${this.root}/${path}`, { on: this.on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file"];
      else if (text.includes("\0")) lines = ["Binary file"];
      else {
        const body = text.replace(/\n$/, "").split("\n").slice(0, MAX_LINES);
        file.add = body.length;
        lines = [`@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`)];
      }
    } else {
      const r = await this.git(["diff", ...(this.baseRef ? [this.baseRef] : ["--cached"]), "--no-ext-diff", "--no-textconv", "--no-color", "--", path]);
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff"] : all.slice(first);
    }
    if (this.open === path) this.setRows(lines.slice(0, MAX_LINES).map((l) => l.length > 2000 ? l.slice(0, 2000) + "…" : l));
  }

  setRows(rows) {
    const keep = this.view[this.cursor];
    this.rows = diffRows(rows);
    this.rebuild();
    const same = keep && this.view.findIndex((r) => r.raw === keep.raw && r.new === keep.new && r.old === keep.old);
    this.cursor = same >= 0 ? same : this.view.findIndex(selectable);
    if (!selectable(this.view[this.anchor])) this.anchor = null;
  }

  rebuild() {
    const mine = this.comments.filter((c) => c.file === this.open);
    this.view = [];
    for (const row of this.rows) {
      this.view.push(row);
      if (!selectable(row)) continue;
      for (const c of mine) {
        const n = c.side === "old" ? row.old : row.new;
        const matches = c.side === "old" ? row.kind === "-" : row.kind !== "-";
        if (matches && n === c.end) this.view.push({ kind: "comment", comment: c });
      }
    }
    this.diffWidth = Math.max(300, ...this.view.map((r) => ((r.text ?? "").length + 1) * 7 + 90));
  }

  loadComments() {
    try { this.comments = JSON.parse(localStorage.getItem(`comments:${this.root}`) ?? "[]"); }
    catch { this.comments = []; }
    this.nextId = Math.max(0, ...this.comments.map((c) => c.id)) + 1;
  }

  saveComments() {
    try { localStorage.setItem(`comments:${this.root}`, JSON.stringify(this.comments)); } catch {}
    this.rebuild();
  }

  pick(path, cx) {
    if (this.open === path) return;
    this.open = path; this.anchor = null; this.cursor = -1; this.setRows([]);
    cx.spawn(async (cx) => {
      try { await this.load(path); } catch (e) { this.note = `Cannot load diff: ${e.message ?? e}`; }
      this.scroll.scroll_to_item(Math.max(0, this.cursor));
      cx.notify();
    });
  }

  moveFile(by, cx) {
    if (!this.files.length) return;
    const i = this.files.findIndex((f) => f.path === this.open);
    this.pick(this.files[(i + by + this.files.length) % this.files.length].path, cx);
  }

  moveCursor(by) {
    let i = this.cursor;
    for (let step = 0; step < Math.abs(by); step++) {
      let j = i + Math.sign(by);
      while (j >= 0 && j < this.view.length && !selectable(this.view[j])) j += Math.sign(by);
      if (j < 0 || j >= this.view.length) break;
      i = j;
    }
    this.cursor = i;
    this.scroll.scroll_to_item(Math.max(0, i));
  }

  jumpChange(by) {
    const changed = (r) => r && (r.kind === "+" || r.kind === "-");
    let i = this.cursor;
    while (changed(this.view[i])) i += by;
    while (i >= 0 && i < this.view.length && !changed(this.view[i])) i += by;
    if (i >= 0 && i < this.view.length) {
      if (by < 0) while (changed(this.view[i - 1])) i--;
      this.cursor = i;
      this.scroll.scroll_to_item(i);
    }
  }

  selection() {
    if (this.cursor < 0) return [];
    const from = Math.min(this.anchor ?? this.cursor, this.cursor), to = Math.max(this.anchor ?? this.cursor, this.cursor);
    return this.view.slice(from, to + 1).filter(selectable);
  }

  inSelection(i) {
    if (this.cursor < 0 || this.anchor === null) return i === this.cursor;
    return i >= Math.min(this.anchor, this.cursor) && i <= Math.max(this.anchor, this.cursor);
  }

  commentAtCursor() {
    const next = this.view[this.cursor + 1];
    if (next?.kind === "comment") return next.comment;
    const row = this.view[this.cursor];
    return row?.kind === "comment" ? row.comment : null;
  }

  startComment(cx) {
    const anchor = anchorOf(this.selection());
    if (!anchor || !this.open) return;
    const existing = this.comments.find((c) => c.file === this.open && c.side === anchor.side && c.start === anchor.start && c.end === anchor.end);
    this.editing = { ...anchor, file: this.open, id: existing?.id };
    this.input.set_value(existing?.text ?? "");
    this.typing = true;
    this.input.focus();
    cx.notify();
  }

  editComment(cx, c = this.commentAtCursor()) {
    if (!c) return;
    this.editing = { ...c };
    this.input.set_value(c.text);
    this.typing = true;
    this.input.focus();
    cx.notify();
  }

  saveComment(cx) {
    const text = this.input.value().trim();
    if (this.editing && text) {
      const { id, ...rest } = this.editing;
      if (id) this.comments = this.comments.map((c) => c.id === id ? { ...c, text } : c);
      else this.comments.push({ ...rest, text, id: this.nextId++ });
      this.saveComments();
    }
    this.cancelComment(cx);
  }

  cancelComment(cx) {
    this.editing = null; this.typing = false; this.anchor = null;
    this.input.set_value("");
    this.handle.focus();
    cx.notify();
  }

  deleteComment(cx, c = this.commentAtCursor()) {
    if (!c) return;
    this.comments = this.comments.filter((x) => x.id !== c.id);
    this.saveComments();
    if (this.listing) {
      this.listIndex = Math.min(this.listIndex, this.comments.length - 1);
      if (!this.comments.length) this.listing = false;
    }
    cx.notify();
  }

  sortedComments() {
    return [...this.comments].sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
  }

  toggleList() {
    if (this.listing) { this.listing = false; return; }
    if (!this.comments.length) { this.note = "No comments yet"; return; }
    this.listing = true;
    this.listIndex = 0;
  }

  goToComment(c, cx) {
    this.listing = false;
    const land = () => {
      const i = this.view.findIndex((r) => r.kind === "comment" && r.comment.id === c.id);
      if (i > 0) { this.cursor = i - 1; this.scroll.scroll_to_item(i); }
    };
    if (this.open === c.file) { land(); cx.notify(); return; }
    this.open = c.file; this.anchor = null; this.cursor = -1; this.setRows([]);
    cx.spawn(async (cx) => {
      try { await this.load(c.file); land(); } catch (e) { this.note = `Cannot load diff: ${e.message ?? e}`; }
      cx.notify();
    });
  }

  onListKey(e, cx) {
    const list = this.sortedComments(), chosen = list[this.listIndex];
    const k = e.key_char ?? e.key;
    const action = {
      j: () => { this.listIndex = Math.min(list.length - 1, this.listIndex + 1); },
      down: () => { this.listIndex = Math.min(list.length - 1, this.listIndex + 1); },
      k: () => { this.listIndex = Math.max(0, this.listIndex - 1); },
      up: () => { this.listIndex = Math.max(0, this.listIndex - 1); },
      enter: () => chosen && this.goToComment(chosen, cx),
      e: () => chosen && this.editComment(cx, chosen),
      d: () => chosen && this.deleteComment(cx, chosen),
      s: () => { this.listing = false; this.send(cx); },
      S: () => { this.listing = false; this.send(cx, true); },
      y: () => this.copy(cx),
      l: () => { this.listing = false; },
      escape: () => { this.listing = false; },
    }[k];
    if (action) action();
    cx.stop_propagation();
    cx.notify();
  }

  candidates() {
    const all = agents();
    const inTab = all.filter((a) => a.tab === this.tab);
    if (inTab.length) return { list: inTab, sure: inTab.length === 1 };
    const inSpace = all.filter((a) => a.space === this.space);
    if (inSpace.length === 1) return { list: inSpace, sure: true };
    return { list: inSpace.length ? inSpace : all, sure: false };
  }

  send(cx, choose = false) {
    if (!this.comments.length) { this.note = "No comments to send"; return; }
    const { list, sure } = this.candidates();
    if (!list.length) { this.note = "No agent found: press y to copy instead"; return; }
    if (sure && !choose) return this.deliver(list[0], cx);
    this.picking = list;
    cx.notify();
  }

  deliver(agent, cx) {
    const count = this.comments.length;
    cx.write_to_clipboard(formatReview(this.root, this.comments));
    run("pane.focus", { terminal: agent.address });
    run("terminal.paste");
    this.comments = []; this.picking = null;
    this.saveComments();
    notify({ title: `Sent ${plural(count, "comment")}`, body: `In ${agent.program?.name ?? agent.title}'s input. Review it and press Enter.`, level: "info", timeout: 4000 });
    cx.notify();
  }

  copy(cx) {
    if (!this.comments.length) { this.note = "No comments to copy"; return; }
    cx.write_to_clipboard(formatReview(this.root, this.comments));
    this.note = `Copied ${plural(this.comments.length, "comment")}`;
  }

  nextComment(by, cx) {
    const list = this.sortedComments();
    if (!list.length) { this.note = "No comments yet"; return; }
    const row = this.view[this.cursor];
    const line = row?.kind === "-" ? row.old : row?.new ?? 0;
    const order = (c) => c.file.localeCompare(this.open ?? "") || c.end - line;
    const target = by > 0 ? list.find((c) => order(c) > 0) ?? list[0] : [...list].reverse().find((c) => order(c) < 0) ?? list[list.length - 1];
    this.goToComment(target, cx);
  }

  quitDiscard() {
    this.comments = [];
    this.saveComments();
    this.closePane();
  }

  openPr(cx) {
    if (!this.root) return;
    this.note = "Looking for the pull request…";
    cx.spawn(async (cx) => {
      try {
        const r = await exec("gh", ["pr", "view", "--json", "url", "-q", ".url"], { cwd: this.root, on: this.on });
        const url = r.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("http")) ?? "";
        if (r.code !== 0 || !url.startsWith("http")) throw new Error((r.stderr || "no pull request for this branch").trim().split("\n")[0]);
        cx.open_url(url);
        this.note = null;
      } catch (e) { this.note = `Cannot open the PR: ${e.message ?? e}`; }
      cx.notify();
    });
  }

  startBasePick(cx) {
    if (!this.root) return;
    cx.spawn(async (cx) => {
      const r = await this.git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads", "refs/remotes"]);
      const refs = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !l.endsWith("/HEAD") && l !== "origin");
      if (!refs.length) { this.note = "No branches found"; cx.notify(); return; }
      const current = refs.indexOf(this.baseOverride ?? this.baseLabel);
      this.basePicking = { refs, index: Math.max(0, current) };
      cx.notify();
    });
  }

  onBaseKey(e, cx) {
    const pick = this.basePicking, k = e.key_char ?? e.key;
    if (k === "j" || k === "down") pick.index = Math.min(pick.refs.length - 1, pick.index + 1);
    else if (k === "k" || k === "up") pick.index = Math.max(0, pick.index - 1);
    else if (k === "pagedown") pick.index = Math.min(pick.refs.length - 1, pick.index + 9);
    else if (k === "pageup") pick.index = Math.max(0, pick.index - 9);
    else if (k === "enter") this.chooseBase(pick.refs[pick.index], cx);
    else if (k === "escape" || k === "B") this.basePicking = null;
    cx.stop_propagation();
    cx.notify();
  }

  chooseBase(ref, cx) {
    this.basePicking = null;
    this.baseOverride = ref;
    this.scope = "branch"; this.open = null; this.setRows([]);
    setShared("reviewr.scope", "branch");
    this.refresh(cx);
  }

  setScope(scope, cx) {
    if (this.scope === scope) return;
    this.scope = scope; this.open = null; this.setRows([]); this.refresh(cx);
    setShared("reviewr.scope", scope);
  }

  onKey(e, cx) {
    if (this.typing) {
      if (e.key === "escape") { this.cancelComment(cx); cx.stop_propagation(); }
      return;
    }
    if (this.picking) {
      const n = Number(e.key);
      if (e.key === "escape") this.picking = null;
      else if (n >= 1 && n <= this.picking.length) this.deliver(this.picking[n - 1], cx);
      cx.stop_propagation(); cx.notify();
      return;
    }
    if (this.basePicking) return this.onBaseKey(e, cx);
    if (this.helping) {
      if (e.key === "escape" || e.key_char === "?" || e.key === "q") this.helping = false;
      cx.stop_propagation(); cx.notify();
      return;
    }
    if (this.listing) return this.onListKey(e, cx);
    const chord = { "ctrl-u": () => this.moveCursor(-10), "ctrl-d": () => this.moveCursor(10) }[e.keystroke];
    if (chord) { this.note = null; chord(); cx.stop_propagation(); cx.notify(); return; }
    const k = e.key_char ?? e.key;
    const handled = {
      j: () => this.moveCursor(1), down: () => this.moveCursor(1),
      k: () => this.moveCursor(-1), up: () => this.moveCursor(-1),
      pagedown: () => this.moveCursor(20), pageup: () => this.moveCursor(-20),
      "]": () => this.jumpChange(1), "[": () => this.jumpChange(-1),
      f: () => this.moveFile(1, cx), F: () => this.moveFile(-1, cx),
      v: () => { this.anchor = this.anchor === null ? this.cursor : null; },
      c: () => this.startComment(cx),
      l: () => this.toggleList(),
      q: () => this.closePane(),
      Q: () => this.quitDiscard(),
      n: () => this.nextComment(1, cx),
      N: () => this.nextComment(-1, cx),
      z: () => { this.hideFiles = !this.hideFiles; },
      w: () => { this.wrap = !this.wrap; },
      o: () => this.openPr(cx),
      B: () => this.startBasePick(cx),
      "?": () => { this.helping = true; },
      e: () => this.editComment(cx),
      d: () => this.deleteComment(cx),
      s: () => this.send(cx),
      S: () => this.send(cx, true),
      y: () => this.copy(cx),
      Y: () => this.copy(cx),
      u: () => this.setScope("uncommitted", cx),
      b: () => this.setScope("branch", cx),
      r: () => { this.resolveTarget(); this.refresh(cx); },
      escape: () => { this.anchor = null; this.note = null; },
    }[k];
    if (!handled) return;
    this.note = null;
    handled();
    cx.stop_propagation();
    cx.notify();
  }

  clickRow(i, e, cx) {
    if (!selectable(this.view[i])) return;
    if (e.modifiers?.shift) { if (this.anchor === null) this.anchor = this.cursor; }
    else this.anchor = null;
    this.cursor = i;
    this.handle.focus();
    if (e.click_count === 2) this.startComment(cx);
    cx.notify();
  }

  row(r, i, t) {
    if (r.kind === "comment") {
      return h_flex().w_full().h(ROW).flex_none().gap(6).px(8).bg(t.accent + "22").text_color(t.foreground)
        .child(div().w(70).flex_none().text_right().text_color(t.accent).child("◆"))
        .child(div().flex_1().min_w(0).truncate().font_family(settings().ui_font ?? "Geist").child(r.comment.text.replace(/\n/g, " ⏎ ")));
    }
    if (r.kind === "@") return div().w_full().h(ROW).flex_none().px(12).truncate().bg(t.raised).text_color(t.dim).child(r.text);
    const picked = this.inSelection(i) && selectable(r);
    return h_flex().id(`r${i}`).w_full().when(this.wrap, (el) => el.min_h(ROW).items_start()).when(!this.wrap, (el) => el.h(ROW)).flex_none().gap(8).cursor_pointer()
      .when(r.kind === "+", (el) => el.bg(t.ansi2 + "18")).when(r.kind === "-", (el) => el.bg(t.ansi1 + "18"))
      .when(picked, (el) => el.bg(t.selection))
      .on_click((e, cx) => this.clickRow(i, e, cx))
      .child(div().w(34).flex_none().text_right().text_color(t.dim).child(r.old === undefined ? "" : String(r.old)))
      .child(div().w(34).flex_none().text_right().text_color(t.dim).child(r.new === undefined ? "" : String(r.new)))
      .child(div().w(10).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind === " " ? "" : r.kind))
      .child(div().flex_1().when(this.wrap, (el) => el.min_w(0).whitespace_normal()).when(!this.wrap, (el) => el.whitespace_nowrap()).child(r.text));
  }

  render(cx) {
    if (this.toggler) return div();
    const t = theme();
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const pill = (label, active, onClick) => div().id(`scope-${label}`).px(8).py(2).rounded(6).text_size(11).cursor_pointer()
      .bg(active ? t.selected : t.background).text_color(active ? t.foreground : t.muted).border_1().border_color(active ? t.accent : t.border)
      .on_click((_e, cx) => onClick(cx)).child(label);
    const count = this.comments.length;
    const filesHeight = Math.max(1, Math.min(this.files.length, 8)) * 26 + 11;
    const hint = this.typing ? "Enter save · Esc cancel"
      : this.picking ? "1–9 pick agent · Esc cancel"
      : this.helping ? "? or Esc close"
      : this.basePicking ? "j/k move · Enter use as base · Esc cancel"
      : this.listing ? "j/k move · Enter go to · e edit · d delete · s send all · S pick · y copy · l/Esc close"
      : this.anchor !== null ? "j/k extend · c comment · Esc clear"
      : "j/k move · v select · c comment · e edit · d delete · l list · ]/[ change · f/F file · s send · y copy · ? keys";
    const listed = this.listing && !this.typing ? this.sortedComments() : [];
    const listStart = Math.max(0, Math.min(this.listIndex - 4, listed.length - 9));
    return v_flex().id("reviewr").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", () => { if (!this.typing) this.handle.focus(); })
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(pill("uncommitted", this.scope === "uncommitted", (cx) => this.setScope("uncommitted", cx)))
        .child(pill(this.scope === "branch" && this.baseLabel ? `branch · ${this.baseLabel}` : "branch", this.scope === "branch", (cx) => this.setScope("branch", cx)))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`))
        .child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .child(div().id("send").px(8).py(2).rounded(6).text_size(11).cursor_pointer()
          .bg(count ? t.solid : t.raised).text_color(count ? t.solid_foreground : t.dim)
          .on_click((_e, cx) => { this.send(cx); cx.notify(); }).child(count ? `Send ${plural(count, "comment")}` : "No comments")))
      .when(!this.hideFiles, (el) => el.child(div().flex_none().h(filesHeight - 1).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("reviewr-files").absolute().inset_0().overflow_y_scroll().p(5).children(this.files.map((f) => {
          const parts = f.path.split("/"), name = parts.pop();
          const notes = this.comments.filter((c) => c.file === f.path).length;
          return h_flex().id(`file-${f.path}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
            .when(this.open === f.path, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.pick(f.path, cx); this.handle.focus(); })
            .child(div().w(12).text_size(11).text_color(f.fresh ? t.ansi2 : t.blocked).child(f.fresh ? "A" : f.del && !f.add ? "D" : "M"))
            .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().min_w(0).truncate().child(name)))
            .when(notes > 0, (el) => el.child(div().text_size(11).text_color(t.accent).child(`◆${notes}`)))
            .when(f.add > 0, (el) => el.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
            .when(f.del > 0, (el) => el.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
        })).when(!this.files.length, (el) => el.child(div().p(6).text_color(t.dim).child(this.error ?? (this.loading ? "Loading…" : `No ${this.scope} changes`)))))
        .child(Scrollbar.vertical("reviewr-files").absolute().inset_0())))
      .child(div().id("reviewr-diff-box").flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .child(div().id("reviewr-diff").absolute().inset_0().overflow_scroll().track_scroll(this.scroll)
          .child(v_flex().when(this.wrap, (el) => el.w_full()).when(!this.wrap, (el) => el.min_w(this.diffWidth)).children(this.view.map((r, i) => this.row(r, i, t)))))
        .child(Scrollbar.vertical("reviewr-diff").absolute().inset_0()))
      .when(Boolean(this.helping), (el) => el.child(v_flex().flex_none().p(8).gap(1).border_t(1).border_color(t.border).bg(t.surface).text_size(11)
        .children(HELP.map(([keys, what]) => h_flex().gap(8)
          .child(div().w(110).flex_none().text_color(t.accent).font_family(settings().font_family ?? "JetBrains Mono").child(keys))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(what))))))
      .when(Boolean(this.basePicking), (el) => {
        const pick = this.basePicking, start = Math.max(0, Math.min(pick.index - 4, pick.refs.length - 9));
        return el.child(v_flex().flex_none().p(8).gap(2).border_t(1).border_color(t.border).bg(t.surface)
          .child(div().text_size(11).text_color(t.muted).child(`Base for the branch scope · ${pick.refs.length} branches`))
          .children(pick.refs.slice(start, start + 9).map((ref, n) => h_flex().id(`base-${ref}`).px(6).py(2).rounded(5).cursor_pointer()
            .when(start + n === pick.index, (s) => s.bg(t.selected)).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.chooseBase(ref, cx))
            .child(div().truncate().child(ref)))));
      })
      .when(listed.length > 0, (el) => el.child(v_flex().flex_none().p(8).gap(2).border_t(1).border_color(t.border).bg(t.surface)
        .child(div().text_size(11).text_color(t.muted).child(`Comments · ${listed.length}`))
        .children(listed.slice(listStart, listStart + 9).map((c, n) => {
          const i = listStart + n;
          return v_flex().id(`comment-${c.id}`).px(6).py(3).rounded(5).cursor_pointer()
            .when(i === this.listIndex, (s) => s.bg(t.selected)).hover((s) => s.bg(t.hover))
            .on_click((e, cx) => { if (e.click_count === 2) this.goToComment(c, cx); else { this.listIndex = i; cx.notify(); } })
            .child(div().text_size(11).text_color(t.accent).truncate().child(location(c)))
            .child(div().text_size(12).truncate().child(c.text.replace(/\n/g, " ⏎ ")));
        }))))
      .when(Boolean(this.picking), (el) => el.child(v_flex().flex_none().p(8).gap(2).border_t(1).border_color(t.border).bg(t.surface)
        .child(div().text_size(11).text_color(t.muted).child("Send to which agent?"))
        .children((this.picking ?? []).slice(0, 9).map((a, n) => h_flex().id(`agent-${a.address}`).gap(8).px(6).py(2).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.deliver(a, cx))
          .child(div().w(14).text_color(t.accent).child(String(n + 1)))
          .child(div().child(a.program?.name ?? a.app ?? "agent"))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`${a.space_name} · ${a.tab_name || `tab ${a.tab_index + 1}`} · ${a.title}`))
          .child(div().text_size(11).text_color(t[a.status] ?? t.dim).child(a.status))))))
      .when(this.typing, (el) => el.child(v_flex().flex_none().p(8).gap(4).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.muted).child(this.editing ? location(this.editing) : ""))
        .child(div().h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).h_full().w_full().text_size(12).text_color(t.foreground)))))
      .child(h_flex().h(26).flex_none().px(10).gap(8).items_center().border_t(1).border_color(t.border).text_size(11)
        .child(div().flex_1().min_w(0).truncate().text_color(this.error ? t.ansi1 : this.note ? t.accent : t.dim).child(this.error ?? this.note ?? hint))
        .child(div().text_color(t.dim).truncate().child((this.root ? this.root.split("/").pop() : ""))));
  }
}
