# DS SuperAgent mobile

The Expo companion pairs with DS SuperAgent over the encrypted link. It can read Main history and work status. Enable message sending for a particular pairing on the computer to use the mobile composer. Computer controls, files and credentials are not available over this connection.

## Build from source

Use Node 24.9 or later within the Node 24 series. Install the repository dependencies from the root so TypeScript can resolve the shared link sources:

```sh
npm --prefix superagent ci
npm --prefix mobile ci
npm --prefix mobile run typecheck
```

In `mobile/`, run `npm run android` with the Android SDK and an emulator or a USB-debugging device, or `npm run ios` on macOS with Xcode. These commands build a native development app; they are not store installs. The generated `android/` and `ios/` directories are not committed.

Run `npm run icons` after the primary logo changes to rebuild the Expo, Android adaptive and splash
icons from `../logo/whale.svg`.

## Pair and send

1. Start `ds-superagent-link` from the product package. For a phone on another machine, put the loopback relay behind a trusted TLS reverse proxy and expose its `/v1/link` endpoint as `wss://`. See the [relay deployment notes](../docs/superagent/implementation/dsbot-port-156-161.md#运行手机中继).
2. On the computer, open **Settings → Phone**, save the relay address, and enable phone access. Leave **Allow this phone to send messages** off for read-only pairing.
3. Open the new pairing QR code. In the phone app, select **Pair computer** and scan it, or paste the one-time link. The app stores its key and the computer's verified public identity in Keychain or Keystore-backed storage, not in chat history or the old product's keys.
4. Open **Main** to read history or send a message if authorized. **Work** shows read-only Main and work state. Unconfirmed messages are never resent automatically. Remove the phone on the computer to revoke its access. Show a new code to change its send permission.

## Verify on a physical Android phone

Use the existing Android Studio SDK and an authorized USB-debugging phone. In `mobile/`, run `npm run android -- --device` and select the physical phone. If the Android project is already generated, you can also run its `app` configuration in Android Studio with the phone selected and `npm start` running for the debug build. Stop if the existing SDK cannot build the project; do not substitute an emulator for this check.

1. Use an [isolated desktop profile with the mock model](../app/README.md#check-a-change). Start the relay at its default `127.0.0.1:8787`, run `adb -d reverse tcp:8787 tcp:8787`, and save `ws://127.0.0.1:8787/v1/link` in **Settings → Phone**. Use WSS outside this local USB check.
2. Pair by scanning a read-only code. Confirm **Main** shows known test history without a composer and **Work** displays a known work state without command controls. Reopen the app and check that it remembers the computer.
3. Pair again with **Allow this phone to send messages** enabled. Send one unique test message from the phone and confirm the desktop records it once and the reply appears on the phone.
4. Remove the phone in desktop settings. Confirm the phone loses access and **Reconnect** shows a readable error. Remove the USB mapping with `adb -d reverse --remove tcp:8787` and stop the test relay.

Record the device model, OS version, revision, and pass/fail results. Do not include pairing codes, links, or screenshots containing them.
