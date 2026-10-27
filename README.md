# tix

Markdown tickets with YAML frontmatter. Each ticket is a `<stem>.md` file in
one directory; `tix` lists, queries and edits them and keeps an index in that
directory's `README.md`.

## Install

Requires Nix with flakes enabled.

Run without installing:

```sh
nix run github:tonyd33/tix -- list
```

Install into your profile:

```sh
nix profile install github:tonyd33/tix
```

Or add it as a flake input and use `tix.packages.${system}.default`:

```nix
inputs.tix.url = "github:tonyd33/tix";
```

Without Nix, run the script with [Bun](https://bun.sh):

```sh
bun tix.ts list
```

## Usage

The tickets directory needs a `README.md` containing the index markers:

```markdown
# Tickets

<!-- BEGIN tix index -->
<!-- END tix index -->
```

```sh
tix -C tickets list
tix -C tickets new fix-parser --summary "Parser drops trailing comments" --kind bug
tix -C tickets close fix-parser resolved
tix -C tickets check
```

`tix --help` lists every command.
