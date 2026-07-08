# Claude Usage — GNOME Shell extension

Shows your Claude plan usage limits in the GNOME top bar. The panel shows the
highest utilization across all limits (`✻ 42%`), turning orange at 80% and red
at 95%. Clicking it opens a popup with a bar per limit — current session,
all-models weekly, and per-model weekly — each with its usage percentage and
reset time, plus a manual refresh.

## How it works

The extension polls the same endpoint Claude Code's `/usage` screen uses
(`https://api.anthropic.com/api/oauth/usage`) every 3 minutes, authenticated
with the OAuth token Claude Code keeps in `~/.claude/.credentials.json`
(`CLAUDE_CONFIG_DIR` is honored). It only reads the token — it never refreshes
or rotates it, so it can't interfere with Claude Code's own session. If the
token has expired, the popup tells you to run `claude` to refresh it.

## Requirements

- GNOME Shell 46
- [Claude Code](https://claude.com/claude-code) installed and logged in

## Install

```sh
git clone https://github.com/laroy-sh/gnome-claude-usage.git \
    ~/.local/share/gnome-shell/extensions/claude-usage@laroy
gnome-extensions enable claude-usage@laroy
```

On Wayland, log out and back in first so GNOME Shell picks up the new
extension (on X11, `Alt+F2`, `r` works).

## Disclaimer

Unofficial. Uses an undocumented endpoint that may change or disappear at any
time. Not affiliated with Anthropic.

## License

GPL-2.0-or-later
