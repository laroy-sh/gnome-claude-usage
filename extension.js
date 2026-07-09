// GNOME Shell 46 extension: Claude plan-usage limits in the top bar.
// Data comes from the same endpoint Claude Code's /usage screen uses,
// authenticated with the OAuth token Claude Code keeps in ~/.claude.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as BarLevel from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_PATH = GLib.build_filenamev([
    GLib.getenv('CLAUDE_CONFIG_DIR') ?? GLib.build_filenamev([GLib.get_home_dir(), '.claude']),
    '.credentials.json',
]);
// ponytail: endpoint 429s when polled hot; 3 min matches community practice
const REFRESH_INTERVAL_S = 180;
const MENU_OPEN_REFRESH_MS = 30000;
// Non-claude-code user agents land in a stricter rate-limit bucket
const USER_AGENT = 'claude-code/2.1.203';

const TITLES = {session: 'Current session', weekly_all: 'All models (weekly)'};

function limitTitle(limit) {
    if (limit.kind === 'weekly_scoped')
        return `${limit.scope?.model?.display_name ?? 'Model'} (weekly)`;
    return TITLES[limit.kind] ?? String(limit.kind ?? 'Unknown');
}

function resetText(limit) {
    const resets = limit.resets_at
        ? GLib.DateTime.new_from_iso8601(limit.resets_at, null) : null;
    if (!resets)
        return '';
    const secs = resets.difference(GLib.DateTime.new_now_utc()) / GLib.TIME_SPAN_SECOND;
    if (secs <= 0)
        return 'Resets soon';
    if (secs < 24 * 3600) {
        const totalMin = Math.round(secs / 60);
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        return h > 0 ? `Resets in ${h} hr ${m} min` : `Resets in ${m} min`;
    }
    return `Resets ${resets.to_local().format('%a %-H:%M')}`;
}

function shortCountdown(limit) {
    const resets = limit.resets_at
        ? GLib.DateTime.new_from_iso8601(limit.resets_at, null) : null;
    if (!resets)
        return null;
    const secs = resets.difference(GLib.DateTime.new_now_utc()) / GLib.TIME_SPAN_SECOND;
    if (secs <= 0)
        return null;
    const totalMin = Math.ceil(secs / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function normalizeLimits(data) {
    if (Array.isArray(data.limits) && data.limits.length > 0)
        return data.limits;
    // ponytail: fallback for the older response schema without a limits array
    const limits = [];
    if (data.five_hour)
        limits.push({kind: 'session', percent: data.five_hour.utilization ?? 0, resets_at: data.five_hour.resets_at});
    if (data.seven_day)
        limits.push({kind: 'weekly_all', percent: data.seven_day.utilization ?? 0, resets_at: data.seven_day.resets_at});
    for (const [name, window] of [['Opus', data.seven_day_opus], ['Sonnet', data.seven_day_sonnet]]) {
        if (window) {
            limits.push({
                kind: 'weekly_scoped',
                percent: window.utilization ?? 0,
                resets_at: window.resets_at,
                scope: {model: {display_name: name}},
            });
        }
    }
    return limits;
}

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({user_agent: USER_AGENT});
        this._settings = this.getSettings();
        this._settingsChangedId = this._settings.connect('changed', () => this._updatePanel());
        this._lastAttemptMs = 0;
        this._lastUpdated = null;
        this._haveData = false;
        this._fetching = false;
        this._limits = null;
        this._tickerId = null;

        this._indicator = new PanelMenu.Button(0.0, 'Claude Usage', false);
        this._panelLabel = new St.Label({
            text: '✻ …',
            y_align: Clutter.ActorAlign.CENTER,
        });
        // A crowded panel allocates labels their minimum width (~0) — don't shrink
        this._panelLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._indicator.add_child(this._panelLabel);

        this._errorItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._errorItem.label.add_style_class_name('claude-usage-error');
        this._errorItem.visible = false;
        this._indicator.menu.addMenuItem(this._errorItem);

        this._limitsSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._limitsSection);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._updatedItem = new PopupMenu.PopupMenuItem('Not updated yet', {reactive: false});
        this._updatedItem.label.add_style_class_name('claude-usage-dim');
        this._updatedItem.label.opacity = 170;
        this._indicator.menu.addMenuItem(this._updatedItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._refresh());
        this._indicator.menu.addMenuItem(refreshItem);

        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open && Date.now() - this._lastAttemptMs > MENU_OPEN_REFRESH_MS)
                this._refresh();
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._refresh();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL_S, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        if (this._tickerId) {
            GLib.Source.remove(this._tickerId);
            this._tickerId = null;
        }
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;
        this._settings = null;
        this._limits = null;
        this._cancellable.cancel();
        this._cancellable = null;
        this._session.abort();
        this._session = null;
        this._indicator.destroy();
        this._indicator = null;
        this._panelLabel = null;
        this._errorItem = null;
        this._limitsSection = null;
        this._updatedItem = null;
    }

    async _refresh() {
        if (this._fetching)
            return;
        this._fetching = true;
        this._lastAttemptMs = Date.now();
        // Fence continuations by enable-cycle: disable() cancels this cancellable,
        // so a stale await can't touch the UI of a newer enable-cycle
        const cancellable = this._cancellable;
        const session = this._session;
        try {
            const token = await this._loadToken(cancellable);
            const data = await this._fetchUsage(session, token, cancellable);
            if (cancellable.is_cancelled())
                return;
            this._lastUpdated = GLib.DateTime.new_now_local();
            this._showLimits(normalizeLimits(data));
            this._haveData = true;
            this._showError(null);
        } catch (e) {
            if (!cancellable.is_cancelled())
                this._showError(e.message);
        } finally {
            if (!cancellable.is_cancelled())
                this._fetching = false;
        }
    }

    async _loadToken(cancellable) {
        let oauth;
        try {
            const file = Gio.File.new_for_path(CREDENTIALS_PATH);
            const [contents] = await file.load_contents_async(cancellable);
            oauth = JSON.parse(new TextDecoder().decode(contents))?.claudeAiOauth;
        } catch {
            throw new Error('No Claude Code credentials found');
        }
        if (!oauth?.accessToken)
            throw new Error('No Claude Code credentials found');
        // Never refresh the token ourselves — that would race Claude Code's own rotation
        if (oauth.expiresAt && oauth.expiresAt <= Date.now())
            throw new Error('Token expired — run claude to refresh it');
        return oauth.accessToken;
    }

    async _fetchUsage(session, token, cancellable) {
        const message = Soup.Message.new('GET', USAGE_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        const status = message.get_status();
        if (status === Soup.Status.UNAUTHORIZED || status === Soup.Status.FORBIDDEN)
            throw new Error('Token expired — run claude to refresh it');
        if (status !== Soup.Status.OK)
            throw new Error(`Usage API returned HTTP ${status}`);
        const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        if (!data || typeof data !== 'object')
            throw new Error('Unexpected usage API response');
        return data;
    }

    _showLimits(limits) {
        this._limitsSection.removeAll();
        for (const limit of limits) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'claude-usage-limit'});

            const header = new St.BoxLayout({x_expand: true});
            header.add_child(new St.Label({text: limitTitle(limit), x_expand: true, style_class: 'claude-usage-title'}));
            header.add_child(new St.Label({text: `${Math.round(limit.percent ?? 0)}% used`, style_class: 'claude-usage-dim', opacity: 170}));
            box.add_child(header);

            box.add_child(new BarLevel.BarLevel({
                value: Math.min(limit.percent ?? 0, 100) / 100,
                style_class: 'slider claude-usage-bar',
                x_expand: true,
            }));

            box.add_child(new St.Label({text: resetText(limit), style_class: 'claude-usage-dim', opacity: 170}));
            item.add_child(box);
            this._limitsSection.addMenuItem(item);
        }

        this._limits = limits;
        this._updatePanel();
        this._updatedItem.label.text = `Last updated: ${this._lastUpdated.format('%H:%M')}`;
    }

    // Renders the panel label from cached limits; returns whether a countdown is showing
    _updatePanel() {
        if (!this._limits?.length)
            return false;
        const session = this._limits.find(l => l.kind === 'session');
        const shown = this._settings.get_boolean('panel-show-session') && session
            ? session
            : this._limits.reduce((a, b) => ((b.percent ?? 0) >= (a.percent ?? 0) ? b : a));
        const percent = shown.percent ?? 0;
        let text = `✻ ${Math.round(percent)}%`;
        let counting = false;
        if (percent >= 100 && this._settings.get_boolean('countdown-when-full')) {
            const left = shortCountdown(shown);
            if (left) {
                text = `✻ ${left}`;
                counting = true;
            }
        }
        this._panelLabel.text = text;
        this._setPanelSeverity(percent >= 95 ? 'critical' : percent >= 80 ? 'warning' : null);
        // Tick once a minute while counting down so the label stays current between fetches
        if (counting && !this._tickerId) {
            this._tickerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
                if (this._updatePanel())
                    return GLib.SOURCE_CONTINUE;
                this._tickerId = null;
                return GLib.SOURCE_REMOVE;
            });
        }
        return counting;
    }

    _showError(message) {
        if (!message) {
            this._errorItem.visible = false;
            return;
        }
        this._errorItem.label.text = `⚠ ${message}`;
        this._errorItem.visible = true;
        // Keep showing the last known numbers if we have them; the popup explains
        if (!this._haveData) {
            this._panelLabel.text = '✻ –';
            this._setPanelSeverity('warning');
        }
    }

    _setPanelSeverity(severity) {
        this._panelLabel.remove_style_class_name('claude-usage-warning');
        this._panelLabel.remove_style_class_name('claude-usage-critical');
        if (severity)
            this._panelLabel.add_style_class_name(`claude-usage-${severity}`);
    }
}
