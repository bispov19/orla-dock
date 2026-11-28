// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// tests/music/fake-player.js — um player MPRIS de mentira para testar o
// widget de música num GNOME Shell de teste (lá não há Spotify).
//
//   gjs -m tests/music/fake-player.js --name a --title "Música" --artist "Artista" \
//       [--length 200] [--paused] [--no-prev] [--no-next] [--no-art] [--long]
//
// Responde a Play/Pause/PlayPause/Next/Previous/SetPosition/Seek e aceita
// Volume por Properties.Set, como um player de verdade.

import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const opts = {name: 'orla_fake', identity: 'Fake Player', title: 'Fake Song', artist: 'Fake Artist',
    album: 'Fake Album', length: 200, paused: false, prev: true, next: true, art: true, color: [0.85, 0.2, 0.3], volume: true, loop: true, silentSeek: false};
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
    case '--color': opts.color = next().split(',').map(Number); break;
    case '--silent-seek': opts.silentSeek = true; break;
    case '--no-volume': opts.volume = false; break;
    case '--no-loop': opts.loop = false; break;
    case '--long': opts.title = 'Uma música com um título comprido demais para caber inteiro na pílula da dock'; break;
    }
}

// Uma capa gerada na hora: fundo na cor pedida, com um círculo claro.
const coverPath = GLib.build_filenamev([GLib.get_user_runtime_dir(), `orla-fake-${opts.name}.png`]);
{
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, 64, 64);
    const cr = new Cairo.Context(surface);
    cr.setSourceRGB(...opts.color);
    cr.paint();
    cr.setSourceRGB(0.95, 0.95, 0.95);
    cr.arc(32, 32, 10, 0, 2 * Math.PI);
    cr.fill();
    cr.$dispose();
    surface.writeToPNG(coverPath);
}
const coverUri = GLib.filename_to_uri(coverPath, null);

let index = 0;
let status = opts.paused ? 'Paused' : 'Playing';
let volume = 0.5;
let loopStatus = 'None';
let shuffle = false;
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
    };
    // Sem duração (--length 0) = como uma transmissão ao vivo.
    if (opts.length > 0)
        md['mpris:length'] = new GLib.Variant('x', opts.length * 1e6);
    if (opts.art)
        md['mpris:artUrl'] = new GLib.Variant('s', coverUri);
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
  ${opts.volume ? '<property name="Volume" type="d" access="readwrite"/>' : ''}
  ${opts.loop ? '<property name="LoopStatus" type="s" access="readwrite"/><property name="Shuffle" type="b" access="readwrite"/>' : ''}
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
        LoopStatus: new GLib.Variant('s', loopStatus),
        Shuffle: new GLib.Variant('b', shuffle),
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
    get LoopStatus() {
        return loopStatus;
    },
    set LoopStatus(v) {
        loopStatus = v;
        notify('LoopStatus');
        print(`LOOP ${v}`);
    },
    get Shuffle() {
        return shuffle;
    },
    set Shuffle(v) {
        shuffle = v;
        notify('Shuffle');
        print(`SHUFFLE ${v}`);
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
        // Como o Spotify: pular no próprio app NÃO emite Seeked.
        if (!opts.silentSeek)
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
