# reviewr for the Herdr app

A code-review pane for the [Herdr app](https://herdr.dev). Read your agent's diff beside the chat, comment on lines, and paste the comments into the agent's input.

![reviewr](preview.png)

## Inspired by herdr-reviewr

This mod is inspired by [herdr-reviewr](https://github.com/persiyanov/herdr-reviewr), Dmitry Persiyanov's plugin for the Herdr TUI. That plugin is a Rust terminal program, and it sends comments through the Herdr TUI socket, which the Herdr app doesn't have. This mod is a separate rewrite for the Herdr app as a native mod (gpui-kit JavaScript), with no code copied from the original. The key bindings and the format of the review it sends follow herdr-reviewr. If you use the Herdr TUI, use the original plugin.

## Install

Tell your agent:

```
Read ~/.config/herdr-app/AGENTS.md, then add this mod: herdr.dev/mods/jacksonpires/herdr-app-reviewr
```

Or by hand: copy `mods/reviewr/` to `~/.config/herdr-app/mods/reviewr/` and merge `keys.json` into `~/.config/herdr-app/keys.json`.

## Use

- `cmd-alt-r` opens reviewr to the right of the focused terminal, on that terminal's repository, and closes it when it is already open in the tab. `q` closes it too. Unsent comments are kept for the next time.
- `u` / `b`: uncommitted changes, or the whole branch against `origin/main` (or the repository's default branch).
- `j` / `k` move, `]` / `[` jump between changes, `f` / `F` switch files.
- `v` selects a range, `c` comments, `e` edits, `d` deletes. Double-click a line to comment on it.
- `l` lists every comment: `j` / `k` move, `Enter` goes to the comment in the diff, `e` edits, `d` deletes, `s` sends them all, `y` copies, `l` or `Esc` closes.
- `s` pastes every comment into the agent's input without pressing Enter, so you can read it first. `S` lets you pick the agent. `y` copies the review.

Sending uses the clipboard and moves the keyboard to the agent's pane.

Not included, compared with herdr-reviewr: the last-turn scope, the PR tab, file search and the split view.

`RECIPE.md` describes the whole mod, so an agent can rebuild it from scratch.

## License

MIT
