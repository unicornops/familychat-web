![Build](https://github.com/unicornops/familychat-web/actions/workflows/build_desktop_linux.yaml/badge.svg?branch=familychat)

# Family Chat Desktop

Family Chat Desktop is the Electron wrapper around the Family Chat web app. It is a fork of
Element Desktop; see the [repository README](../../README.md) for provenance and licensing.

# First Steps

Before you do anything else, fetch the dependencies:

```
pnpm install
```

# Fetching the web app

This package is only the Electron wrapper, so it needs a built copy of the web app first.
Build it in-tree:

```
pnpm --filter familychat-web build
cp -r ../web/webapp ./webapp
pnpm run asar-webapp
```

Or, for development, symlink it instead of packing an asar:

```
ln -s ../web/webapp ./
```

> [!WARNING]
> Do **not** use `pnpm run fetch`. It still downloads Element's release tarball from
> `github.com/element-hq` and verifies it against Element's signing key. Rewiring it to our own
> releases is tracked in [unicornops/family-chat#235](https://github.com/unicornops/family-chat/issues/235).

# Building

## Native Build

TODO: List native pre-requisites

Optionally, [build the native modules](../../docs/native-node-modules.md), which include support
for searching in encrypted rooms and secure storage. Skipping this step is fine, you just won't
have those features; CI skips it, so CI artifacts do not have them either. electron-builder still
expects the directory to exist, so `mkdir -p .hak/hakModules` if you skip it.

Then, run

```
pnpm run build
```

This will do a couple of things:

- Run the `setversion` script to set the local package version to match whatever
  version of the web app you installed above.
- Run electron-builder to build a package. The package built will match the operating system
  you're running the build process on.

## Docker

Alternatively, you can also build using docker, which will always produce the linux package:

```
# Run this once to make the docker image
pnpm run docker:setup

pnpm run docker:install
# if you want to build the native modules (this will take a while)
pnpm run docker:build:native
pnpm run docker:build
```

After running, the packages should be in `dist/`.

# Starting

If you'd just like to run the electron app locally for development:

```
pnpm start
```

# Config

The config baked into a package is the `config.json` sitting next to the packed web app. The
config for the official Family Chat builds is in [`familychat/`](https://github.com/unicornops/familychat-web/tree/familychat/apps/desktop/familychat), alongside
`build.json`, the electron-builder variant that `VARIANT_PATH` selects (and which
`electron-builder.ts` uses by default). Building with it points the app at the Family Chat update
feed, so you probably only want it for official builds.

# Profiles

To run multiple instances of the desktop app for different accounts, you can
launch the executable with the `--profile` argument followed by a unique
identifier, e.g `familychat --profile Work` for it to run a separate profile and
not interfere with the default one.

Alternatively, a custom location for the profile data can be specified using the
`--profile-dir` flag followed by the desired path.

# User-specified config.json

- `%APPDATA%\$NAME\config.json` on Windows
- `$XDG_CONFIG_HOME/$NAME/config.json` or `~/.config/$NAME/config.json` on Linux
- `~/Library/Application Support/$NAME/config.json` on macOS

In the paths above, `$NAME` is typically `Family Chat`, unless you use `--profile
$PROFILE` in which case it becomes `Family Chat-$PROFILE`.

You may also specify a different path entirely for the `config.json` file by
providing the `--config $YOUR_CONFIG_JSON_FILE` to the process, or via the
`ELEMENT_DESKTOP_CONFIG_JSON` environment variable (the variable keeps its upstream name).

# Translations

Localazy is Element's, so only the English source strings in `src/i18n/strings/en_EN.json` are
maintained here; the other locales are inherited from upstream. For a developer guide, see the
[translating dev doc](../../docs/translating-dev.md).

# Report bugs & give feedback

Family Chat issues are tracked in
[unicornops/family-chat](https://github.com/unicornops/family-chat/issues). If the bug also happens
in Element Desktop, please report it [upstream](https://github.com/element-hq/element-web/issues)
so everyone benefits.

## Copyright & Licence

See [Copyright & licence](../../README.md#copyright--licence) in the repository README. Upstream
Element Desktop is multi-licensed by Element under AGPL-3.0, GPL-3.0 or a paid Element Commercial
Licence; Family Chat takes the AGPL-3.0 option.
