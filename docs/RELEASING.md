# Releasing

## Update signing keys (once)

BigView updates itself from GitHub Releases (D51). Every update bundle is
signed, and the app installs only bundles signed by the key it was built
with. The key pair is made once by whoever publishes releases and is never
committed.

1. Make the key pair (choose a password when asked; keep both safe, since
   without them no update can ever be signed for the apps already out
   there):

   ```sh
   pnpm tauri signer generate -w ~/.tauri/bigview.key
   ```

   This writes the private key to `~/.tauri/bigview.key` and the public key
   to `~/.tauri/bigview.key.pub`.

2. In the GitHub repository, under Settings › Secrets and variables ›
   Actions, add:

   | Name | Kind | Value |
   | --- | --- | --- |
   | `TAURI_SIGNING_PRIVATE_KEY` | secret | the contents of `bigview.key` |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret | its password |
   | `BIGVIEW_UPDATER_PUBKEY` | variable | the contents of `bigview.key.pub` |

The release workflow turns the updater on only when the public key is set;
without it the release still builds, and its apps say they can't update
themselves (Help › Check for updates).

## What a release build does differently

```sh
BIGVIEW_UPDATER_PUBKEY=... node scripts/updater-config.mjs target/updater.conf.json
TAURI_SIGNING_PRIVATE_KEY=... pnpm tauri build --config target/updater.conf.json
```

The overlay adds the public key and the manifest URL
(`https://github.com/<repo>/releases/latest/download/latest.json`) and makes
the bundler write a `.sig` next to each update bundle. The release workflow
uploads the bundles, their signatures and a `latest.json` manifest that
lists them per platform.

To try updates locally, serve a `latest.json` on `http://127.0.0.1` and set
`BIGVIEW_UPDATER_ENDPOINT` to it (plain HTTP is only accepted for this
computer).
