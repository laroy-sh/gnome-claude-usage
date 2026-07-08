import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({title: 'Top Bar'});

        const sessionRow = new Adw.SwitchRow({
            title: 'Show session limit',
            subtitle: 'Show the current session percentage instead of the highest limit',
        });
        settings.bind('panel-show-session', sessionRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(sessionRow);

        const countdownRow = new Adw.SwitchRow({
            title: 'Countdown when a limit is hit',
            subtitle: 'At 100%, show time until reset instead of the percentage',
        });
        settings.bind('countdown-when-full', countdownRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(countdownRow);

        page.add(group);
        window.add(page);
    }
}
