# Releasing

## Making a release

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` (then `cargo check` to update `Cargo.lock`), move the
   CHANGELOG's "Unreleased" notes under the new version, and merge to `main`.
2. Optional: run the **Release** workflow by hand (Actions › Release › Run
   workflow, "dry run" ticked). It builds every installer on Windows, macOS and
   Linux and keeps them, with `SHA256SUMS.txt` and `latest.json`, as the
   `release-dry-run` artifact; nothing is published.
3. Tag `main` and push the tag: `git tag -a v1.2.3 -m "DataLiq 1.2.3" && git push
   origin v1.2.3`. The workflow checks the tag against the app version, builds,
   and creates a **draft** release named "DataLiq 1.2.3" with the installers,
   `SHA256SUMS.txt`, `latest.json` (when the update key is set up) and the
   version's CHANGELOG section as its notes.
4. Review the draft on GitHub (download an installer, check its checksum) and
   publish it. The apps already out there see the update once it is published:
   the manifest URL points at the latest *published* release.

| Platform | Files |
| --- | --- |
| Windows x64 | `DataLiq_<v>_x64-setup.exe` (NSIS, per user), `DataLiq_<v>_x64_en-US.msi` |
| macOS 12+ | `DataLiq_<v>_universal.dmg`, `DataLiq_<v>_universal.app.tar.gz` (updates) |
| Linux x64 | `DataLiq_<v>_amd64.AppImage`, `DataLiq_<v>_amd64.deb`, `DataLiq-<v>-1.x86_64.rpm` |

### macOS signing (optional)

Without these secrets the macOS app is unsigned and people open it the first
time with right-click › Open. With a Developer ID certificate, add
`APPLE_CERTIFICATE` (the .p12, base64), `APPLE_CERTIFICATE_PASSWORD` and
`APPLE_SIGNING_IDENTITY`; add `APPLE_ID`, `APPLE_PASSWORD` (an app-specific
password) and `APPLE_TEAM_ID` to notarize too.

## Update signing keys (once)

DataLiq updates itself from GitHub Releases (D51). Every update bundle is
signed, and the app installs only bundles signed by the key it was built
with. The key pair is made once by whoever publishes releases and is never
committed.

1. Make the key pair (choose a password when asked; keep both safe, since
   without them no update can ever be signed for the apps already out
   there):

   ```sh
   pnpm tauri signer generate -w ~/.tauri/dataliq.key
   ```

   This writes the private key to `~/.tauri/dataliq.key` and the public key
   to `~/.tauri/dataliq.key.pub`.

2. In the GitHub repository, under Settings › Secrets and variables ›
   Actions, add:

   | Name | Kind | Value |
   | --- | --- | --- |
   | `TAURI_SIGNING_PRIVATE_KEY` | secret | the contents of `dataliq.key` |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret | its password |
   | `DATALIQ_UPDATER_PUBKEY` | variable | the contents of `dataliq.key.pub` |

The release workflow turns the updater on only when the public key is set;
without it the release still builds, and its apps say they can't update
themselves (Help › Check for updates).

## What a release build does differently

```sh
DATALIQ_UPDATER_PUBKEY=... node scripts/updater-config.mjs target/updater.conf.json
TAURI_SIGNING_PRIVATE_KEY=... pnpm tauri build --config target/updater.conf.json
```

The overlay adds the public key and the manifest URL
(`https://github.com/<repo>/releases/latest/download/latest.json`) and makes
the bundler write a `.sig` next to each update bundle. The release workflow
uploads the bundles, their signatures and a `latest.json` manifest that
lists them per platform.

To try updates locally, serve a `latest.json` on `http://127.0.0.1` and set
`DATALIQ_UPDATER_ENDPOINT` to it (plain HTTP is only accepted for this
computer).
