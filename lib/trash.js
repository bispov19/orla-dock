// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// trash.js — a Lixeira na dock.
//
// O GNOME expõe a lixeira como um "sistema de arquivos virtual" do GVfs no
// endereço trash:///. Com o Gio podemos:
//   - ler 'trash::item-count' para saber se está vazia ou cheia;
//   - monitorar mudanças (monitor_directory);
//   - apagar definitivamente cada item (delete_async) para esvaziar.
//
// Também é um alvo de "soltar": arraste um app fixado para tirá-lo da dock
// ou um arquivo de uma Stack para mandá-lo à lixeira.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {poof} from './animations.js';
import {AppIcon} from './appIcon.js';
import {SimpleMenu} from './appMenu.js';
import {DockItem} from './dockItem.js';
import {Timeout} from './utils.js';

const TRASH_URI = 'trash:///';

export const TrashItem = GObject.registerClass(
class OrlaTrashItem extends DockItem {
    _init(dock) {
        super._init(dock);
        this.key = 'trash';
        this._trash = Gio.File.new_for_uri(TRASH_URI);
        this._full = false;
        this._cancellable = new Gio.Cancellable();
        this._update = new Timeout();

        try {
            this._monitor = this._trash.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => this._update.start(300, () => this._queryCount()));
        } catch {
            this._monitor = null;
        }
        this._queryCount();

        this.connect('clicked', () => this._open());
        this.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this.dock.openMenu(this, new SimpleMenu(this, [
                {label: _('Open'), callback: () => this._open()},
                null,
                {label: _('Empty Trash'), callback: () => this._confirmEmpty(), sensitive: this._full},
            ]));
            return Clutter.EVENT_STOP;
        });
    }

    get labelText() {
        return _('Trash');
    }

    createIcon(size) {
        const name = this._full ? 'user-trash-full' : 'user-trash';
        // Visual da própria Dock: um cesto prateado que acompanha a extensão,
        // independente do tema de ícones.
        if (this.dock.settings.get_string('trash-icon-style') === 'dock') {
            const path = `${this.dock.manager.extensionPath}/icons/trash/${name}.svg`;
            return new St.Icon({gicon: Gio.FileIcon.new(Gio.File.new_for_path(path)), icon_size: size});
        }
        return new St.Icon({icon_name: name, icon_size: size});
    }

    _queryCount() {
        this._trash.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, this._cancellable, (file, res) => {
                let full = false;
                try {
                    full = file.query_info_finish(res).get_attribute_uint32('trash::item-count') > 0;
                } catch {
                    return;
                }
                if (full !== this._full) {
                    this._full = full;
                    this.refreshIcon();
                }
            });
    }

    _open() {
        const context = global.create_app_launch_context(0, -1);
        Gio.AppInfo.launch_default_for_uri_async(TRASH_URI, context, null, null);
    }

    _confirmEmpty() {
        const dialog = new ModalDialog.ModalDialog({styleClass: 'orla-trash-dialog'});
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: _('Empty all items from Trash?'),
            description: _('All items in the Trash will be permanently deleted.'),
        }));
        dialog.addButton({label: _('Cancel'), action: () => dialog.close(), key: Clutter.KEY_Escape});
        dialog.addButton({
            label: _('Empty Trash'),
            action: () => {
                dialog.close();
                this._empty();
            },
            default: true,
        });
        dialog.open();
    }

    /** Apaga, de forma assíncrona, cada item da lixeira. */
    _empty() {
        this._trash.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, this._cancellable, (trash, res) => {
                let enumerator;
                try {
                    enumerator = trash.enumerate_children_finish(res);
                } catch (e) {
                    Main.notifyError(_('Could not empty the Trash'), e.message);
                    return;
                }
                const next = () => {
                    enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, this._cancellable, (en, r) => {
                        let infos = [];
                        try {
                            infos = en.next_files_finish(r);
                        } catch {}
                        for (const info of infos) {
                            trash.get_child(info.get_name())
                                .delete_async(GLib.PRIORITY_DEFAULT, this._cancellable, null);
                        }
                        if (infos.length > 0)
                            next();
                        else
                            en.close_async(GLib.PRIORITY_DEFAULT, null, null);
                    });
                };
                next();
            });
    }

    // ---------- Arrastar para a lixeira ----------

    _canAccept(source) {
        if (source?.file)
            return true;
        return source instanceof AppIcon && this.dock.manager.appTracker.isPinned(source.app);
    }

    handleDragOver(source) {
        if (!this._canAccept(source))
            return DND.DragMotionResult.CONTINUE;
        this.add_style_pseudo_class('drop');
        if (!this._dragLeaveWatch) {
            this._dragLeaveWatch = new Timeout();
        }
        this._dragLeaveWatch.start(200, () => this.remove_style_pseudo_class('drop'));
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        if (!this._canAccept(source))
            return false;
        this.remove_style_pseudo_class('drop');
        if (source.file) {
            source.file.trash_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
                try {
                    file.trash_finish(res);
                } catch (e) {
                    Main.notifyError(_('Could not move to Trash'), e.message);
                }
            });
        } else {
            const rect = this.getRestIconRect();
            if (rect)
                poof(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width);
            this.dock.manager.appTracker.unpin(source.app.get_id());
        }
        return true;
    }

    destroy() {
        this._cancellable.cancel();
        this._update.cancel();
        this._dragLeaveWatch?.cancel();
        this._monitor?.cancel();
        super.destroy();
    }
});
