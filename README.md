# Orla Dock

Uma dock para o GNOME Shell inspirada na Dock do macOS: ampliação dos ícones em onda, Stacks, Lixeira, auto-ocultar, indicadores de apps abertos e muito mais. É uma extensão nativa: todo o código roda dentro do GNOME Shell, sem processos externos.

> 🚧 **Em desenvolvimento.** Fase atual: **0 (estrutura)**. Ainda não há dock visível.

## Compatibilidade

- GNOME Shell 51 (testado) e 50
- Wayland e X11
- Uma dock por monitor, em qualquer borda da tela (inferior, superior, esquerda ou direita)

## Instalação (a partir do código-fonte)

Dependências no Fedora:

```sh
sudo dnf install git glib2-devel gettext mutter-devkit
```

Clonar e instalar:

```sh
git clone git@github.com:viniciusbispo19/orla-dock.git ~/Projetos/orla-dock
cd ~/Projetos/orla-dock
./scripts/install.sh
```

O `install.sh` compila o schema e as traduções e cria um link simbólico em `~/.local/share/gnome-shell/extensions/orla-dock@viniciusbispo19`.

No Wayland, o GNOME Shell só detecta extensões novas depois de sair da sessão e entrar de novo. Depois disso:

```sh
gnome-extensions enable orla-dock@viniciusbispo19
```

## Desenvolvimento

| Script | O que faz |
| --- | --- |
| `scripts/install.sh` | Compila o schema e as traduções e instala o link simbólico |
| `scripts/nested.sh` | Abre uma sessão GNOME de teste numa janela (`gnome-shell --devkit`) |
| `scripts/update-po.sh` | Extrai os textos traduzíveis e atualiza `po/*.po` |

Para ver os logs da sessão principal:

```sh
journalctl -f -o cat /usr/bin/gnome-shell
```

Para ver os logs da janela de preferências:

```sh
journalctl -f -o cat /usr/bin/gjs
```

## Licença

[GPL-3.0-or-later](LICENSE)
