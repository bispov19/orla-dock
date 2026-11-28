// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// music/appStreams.js — descobre quais fluxos de áudio ("sink inputs" do
// PipeWire/PulseAudio) são de um player MPRIS: o plano B do volume, para
// players que não publicam Volume pelo MPRIS (mexemos no volume DO APP,
// o mesmo de Configurações › Som › Níveis de volume, nunca no geral).
//
// O Gvc (biblioteca de áudio do Shell) não informa o PID de cada fluxo;
// perguntamos ao `pactl` (assíncrono). Ordem de confiança:
//   1. o fluxo vem do processo que publicou o MPRIS ou de um FILHO dele
//      (navegadores e apps Electron tocam num subprocesso);
//   2. o fluxo vem de um processo das janelas do app (Flatpak);
//   3. nomes iguais (sem pactl, ou PIDs que não batem).
// A árvore de processos é lida de /proc de forma assíncrona.

import Gio from 'gi://Gio';

import {readBytes} from '../files.js';
import {busBaseName} from './mpris.js';

const MAX_DEPTH = 32;
// Nomes que não identificam um app (ex.: com.spotify.Client → "client").
const GENERIC_NAMES = new Set([
    'chromium', 'electron', 'client', 'desktop', 'app', 'player', 'browser', 'applicationsmultimedia',
]);

export const normalizeName = name =>
    String(name ?? '').toLowerCase().replace(/\.desktop$/, '').replace(/[^a-z0-9]/g, '');

const toPid = value => {
    const pid = parseInt(value, 10);
    return pid > 0 ? pid : 0;
};

/** Junta `pactl -f json list sink-inputs` e `... list clients`: índice do fluxo → dono. */
export function parseOwners(inputs, clients) {
    const clientProps = new Map(clients.map(c => [String(c.index), c.properties ?? {}]));
    const owners = new Map();
    for (const input of inputs) {
        const props = input.properties ?? {};
        const client = clientProps.get(String(input.client)) ?? {};
        // PulseAudio: PID no fluxo; PipeWire nativo: no client. O
        // pipewire.sec.pid por último (num cliente PulseAudio é o do pipewire-pulse).
        const pid = toPid(props['application.process.id']) ||
            toPid(client['application.process.id']) || toPid(client['pipewire.sec.pid']);
        const names = [
            props['application.name'], props['application.process.binary'], props['application.id'],
            props['pipewire.access.portal.app_id'], client['application.name'],
            client['pipewire.access.portal.app_id'],
        ].filter(Boolean);
        owners.set(Number(input.index), {pid, names});
    }
    return owners;
}

/** PID do pai, lido de /proc/<pid>/stat (0 se não existir). */
async function parentPid(pid) {
    try {
        const text = new TextDecoder().decode(await readBytes(Gio.File.new_for_path(`/proc/${pid}/stat`)));
        // "123 (nome) S 45 …": o nome pode ter espaços e parênteses.
        return toPid(text.slice(text.lastIndexOf(')') + 2).split(' ')[1]);
    } catch {
        return 0;
    }
}

async function descendsFrom(pid, roots, parentOf) {
    for (let depth = 0; pid > 1 && depth < MAX_DEPTH; depth++) {
        if (roots.has(pid))
            return true;
        pid = await parentOf(pid);
    }
    return false;
}

/** Os fluxos do player, na ordem de confiança acima. */
export async function pickStreams(entries, player) {
    const memo = new Map();
    const parentOf = pid => {
        if (!memo.has(pid))
            memo.set(pid, parentPid(pid));
        return memo.get(pid);
    };
    const tiers = [
        new Set([player.pid].filter(p => p > 0)),
        new Set(player.appPids.filter(p => p > 0)),
    ];
    for (const roots of tiers) {
        if (!roots.size)
            continue;
        const found = [];
        for (const e of entries) {
            if (e.pid > 0 && await descendsFrom(e.pid, roots, parentOf))
                found.push(e.stream);
        }
        if (found.length)
            return found;
    }
    const wanted = new Set(player.names.map(normalizeName).filter(n => n && !GENERIC_NAMES.has(n)));
    return entries.filter(e => e.names.some(n => wanted.has(normalizeName(n)))).map(e => e.stream);
}

export function describePlayer(player) {
    const appId = player.app?.get_id() ?? '';
    return {
        pid: player.pid ?? 0,
        appPids: player.app?.get_pids() ?? [],
        names: [
            player.identity, player.app?.get_name(), appId,
            appId.replace(/\.desktop$/, '').split('.').pop(),
            busBaseName(player.busName),
        ].filter(Boolean),
    };
}

function runPactl(args, cancellable) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(['pactl', '-f', 'json', ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            reject(e);   // pactl não instalado
            return;
        }
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                if (!p.get_successful())
                    throw new Error(`pactl ${args.join(' ')} falhou`);
                resolve(JSON.parse(stdout));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Donos (PID/nomes) de todos os fluxos. Lança erro se o pactl falhar. */
export async function readOwners(cancellable) {
    const [inputs, clients] = await Promise.all([
        runPactl(['list', 'sink-inputs'], cancellable),
        runPactl(['list', 'clients'], cancellable),
    ]);
    return parseOwners(inputs, clients);
}
