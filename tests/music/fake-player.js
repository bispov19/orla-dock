// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Vinicius Bispo
//
// tests/music/fake-player.js — um player MPRIS de mentira para testar o
// widget de música num GNOME Shell de teste (lá não há Spotify).
//
//   gjs -m tests/music/fake-player.js --name a --title "Música" --artist "Artista" \
//       [--length 200] [--paused] [--no-prev] [--no-next] [--no-art] [--long]
//
// Responde a Play/Pause/PlayPause/Next/Previous/SetPosition/Seek e aceita
// Volume por Properties.Set, como um player de verdade.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const opts = {name: 'orla_fake', identity: 'Fake Player', title: 'Fake Song', artist: 'Fake Artist',
    album: 'Fake Album', length: 200, paused: false, prev: true, next: true, art: true};
const args = System.programArgs;
for (let i = 0; i < args.length; i++) {
    const next = () => args[++i];
    switch (args[i]) {
    case '--name': opts.name = next(); break;
    case '--identity': opts.identity = next(); break;
    case '--title': opts.title = next(); break;
    case '--artist': opts.artist = next(); break;
    case '--album': opts.album = next(); break;
    case '--length': opts.length = Number(next()); break;
    case '--paused': opts.paused = true; break;
    case '--no-prev': opts.prev = false; break;
    case '--no-next': opts.next = false; break;
    case '--no-art': opts.art = false; break;
    case '--long': opts.title = 'Uma música com um título comprido demais para caber inteiro na pílula da dock'; break;
    }
}

let index = 0;
let status = opts.paused ? 'Paused' : 'Playing';
let volume = 0.5;
let basePos = 0;
let baseTime = GLib.get_monotonic_time();
const position = () => basePos + (status === 'Playing' ? GLib.get_monotonic_time() - baseTime : 0);
const setPos = p => {
    basePos = p;
    baseTime = GLib.get_monotonic_time();
};
const trackId = () => `/org/orla/fake/${opts.name}/track${index}`;
const title = () => index === 0 ? opts.title : `${opts.title} ${index + 1}`;

function metadata() {
    const md = {
        'mpris:trackid': new GLib.Variant('o', trackId()),
        'xesam:title': new GLib.Variant('s', title()),
        'xesam:artist': new GLib.Variant('as', [opts.artist]),
        'xesam:album': new GLib.Variant('s', opts.album),
        'mpris:length': new GLib.Variant('x', opts.length * 1e6),
    };
    // Uma capa gerada na hora (data: com um PNG 1x1 colorido).
    if (opts.art) {
        md['mpris:artUrl'] = new GLib.Variant('s',
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
    }
    return md;
}

const ROOT_XML = `<node><interface name="org.mpris.MediaPlayer2">
  <method name="Raise"/><method name="Quit"/>
  <property name="CanQuit" type="b" access="read"/>
  <property name="CanRaise" type="b" access="read"/>
  <property name="HasTrackList" type="b" access="read"/>
  <property name="Identity" type="s" access="read"/>
  <property name="DesktopEntry" type="s" access="read"/>
</interface></node>`;

const PLAYER_XML = `<node><interface name="org.mpris.MediaPlayer2.Player">
  <method name="Next"/><method name="Previous"/><method name="Pause"/>
  <method name="PlayPause"/><method name="Stop"/><method name="Play"/>
  <method name="Seek"><arg direction="in" name="Offset" type="x"/></method>
  <method name="SetPosition"><arg direction="in" name="TrackId" type="o"/><arg direction="in" name="Position" type="x"/></method>
  <signal name="Seeked"><arg name="Position" type="x"/></signal>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Rate" type="d" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="Volume" type="d" access="readwrite"/>
  <property name="Position" type="x" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
  <property name="CanPlay" type="b" access="read"/>
  <property name="CanPause" type="b" access="read"/>
  <property name="CanSeek" type="b" access="read"/>
  <property name="CanControl" type="b" access="read"/>
</interface></node>`;

const loop = new GLib.MainLoop(null, false);
let exported;
function notify(...props) {
    const values = {
        PlaybackStatus: new GLib.Variant('s', status),
        Metadata: new GLib.Variant('a{sv}', metadata()),
        Volume: new GLib.Variant('d', volume),
    };
    for (const p of props)
        exported.emit_property_changed(p, values[p]);
    exported.flush();
}
function setStatus(s) {
    setPos(position());
    status = s;
    notify('PlaybackStatus');
    print(`STATUS ${s}`);
}
function changeTrack(step) {
    index = Math.max(0, index + step);
    setPos(0);
    status = 'Playing';
    notify('Metadata', 'PlaybackStatus');
    print(`TRACK ${title()}`);
}

const root = {
    CanQuit: true, CanRaise: false, HasTrackList: false, Identity: opts.identity, DesktopEntry: '',
    Raise() {},
    Quit() {
        loop.quit();
    },
};
const player = {
    get PlaybackStatus() {
        return status;
    },
    get Metadata() {
        return metadata();
    },
    get Position() {
        return position();
    },
    get Volume() {
        return volume;
    },
    set Volume(v) {
        volume = Math.max(0, Math.min(1, v));
        notify('Volume');
        print(`VOLUME ${volume.toFixed(2)}`);
    },
    Rate: 1,
    CanGoNext: opts.next, CanGoPrevious: opts.prev, CanPlay: true, CanPause: true, CanSeek: true, CanControl: true,
    Next: () => opts.next && changeTrack(1),
    Previous: () => opts.prev && changeTrack(-1),
    Play: () => setStatus('Playing'),
    Pause: () => setStatus('Paused'),
    Stop: () => setStatus('Stopped'),
    PlayPause: () => setStatus(status === 'Playing' ? 'Paused' : 'Playing'),
    Seek(offset) {
        setPos(Math.max(0, position() + offset));
        exported.emit_signal('Seeked', new GLib.Variant('(x)', [position()]));
    },
    SetPosition(id, pos) {
        if (id !== trackId())
            return;
        setPos(pos);
        exported.emit_signal('Seeked', new GLib.Variant('(x)', [pos]));
        print(`SEEK ${(pos / 1e6).toFixed(1)}`);
    },
};

Gio.DBusExportedObject.wrapJSObject(ROOT_XML, root).export(Gio.DBus.session, '/org/mpris/MediaPlayer2');
exported = Gio.DBusExportedObject.wrapJSObject(PLAYER_XML, player);
exported.export(Gio.DBus.session, '/org/mpris/MediaPlayer2');
Gio.bus_own_name_on_connection(Gio.DBus.session, `org.mpris.MediaPlayer2.${opts.name}`,
    Gio.BusNameOwnerFlags.NONE, () => print('READY'), () => loop.quit());
loop.run();
