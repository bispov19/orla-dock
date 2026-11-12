// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// mounts.js — pendrives, HDs externos e outras unidades na dock.
//
// O Gio.VolumeMonitor é o "vigia" de unidades do GLib: ele sabe o que está
// montado agora (get_mounts) e emite sinais quando algo é conectado
// ('mount-added') ou removido ('mount-removed'). O DockManager escuta esses
// sinais e refaz a dock na hora — a unidade só aparece enquanto está
// conectada.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SimpleMenu} from './appMenu.js';
import {DockItem} from './dockItem.js';

/** Identificador estável de uma unidade: o endereço da raiz dela. */
export function mountKey(mount) {
    return `mount:${mount.get_root().get_uri()}`;
}

export const MountItem = GObject.registerClass(
class OrlaMountItem extends DockItem {
    _init(dock, mount) {
        super._init(dock);
        this.mount = mount;
        this.key = mountKey(mount);

        // Clique: abre a unidade no gerenciador de arquivos.
        this.connect('clicked', () => this._open());
        this.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this.dock.openMenu(this, this._createMenu());
            return Clutter.EVENT_STOP;
        });
    }

    get labelText() {
        return this.mount.get_name();
    }

    createIcon(size) {
        return new St.Icon({
            gicon: this.mount.get_icon() ?? Gio.ThemedIcon.new('drive-removable-media'),
            icon_size: size,
        });
    }

    _open() {
        const context = global.create_app_launch_context(0, -1);
        Gio.AppInfo.launch_default_for_uri_async(this.mount.get_root().get_uri(),
            context, null, null);
    }

    _createMenu() {
        const entries = [{label: _('Open'), callback: () => this._open()}];
        if (this.mount.can_eject())
            entries.push(null, {label: _('Eject'), callback: () => this._eject()});
        else if (this.mount.can_unmount())
            entries.push(null, {label: _('Unmount'), callback: () => this._unmount()});
        return new SimpleMenu(this, entries);
    }

    // Ejetar/desmontar é assíncrono: o sistema pode demorar (gravando dados).
    // Gio.MountOperation permite que o sistema pergunte algo, se precisar.
    _eject() {
        this.mount.eject_with_operation(Gio.MountUnmountFlags.NONE,
            new Gio.MountOperation(), null, (mount, res) => {
                try {
                    mount.eject_with_operation_finish(res);
                } catch (e) {
                    Main.notifyError(_('Could not eject the drive'), e.message);
                }
            });
    }

    _unmount() {
        this.mount.unmount_with_operation(Gio.MountUnmountFlags.NONE,
            new Gio.MountOperation(), null, (mount, res) => {
                try {
                    mount.unmount_with_operation_finish(res);
                } catch (e) {
                    Main.notifyError(_('Could not unmount the drive'), e.message);
                }
            });
    }
});
