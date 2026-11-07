<div align="center">

<img src="public/logo.svg" alt="Watchify logo" width="112" height="112">

# Watchify

### Movies are better together. 🍿

**Create a room. Invite your friends. Watch in sync.**

A real-time watch-party website with synchronized playback, live chat, host controls, and Google Drive video support.

[![Live Website](https://img.shields.io/badge/Watchify-Live%20Website-0A84FF?style=for-the-badge&logo=googlechrome&logoColor=white)](https://watchify.mixify.co.in/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-Realtime-111111?style=for-the-badge&logo=socketdotio&logoColor=white)](https://socket.io/)

[**🌐 Open Watchify**](https://watchify.mixify.co.in/) · [**💜 Mixify**](https://mixify.co.in/) · [**👨‍💻 Developer Portfolio**](https://portfolio.mixify.co.in/)

</div>

---

## ✨ Features

| Feature | Description |
| --- | --- |
| 🎬 Synced playback | Play, pause, seek and resync across viewers. |
| 👑 Host controls | Everyone / host-only / request-remote, member management and host transfer. |
| 💬 Chat & reactions | Live chat, reactions and timeline reaction markers. |
| ☁️ Google Drive | Optional Google login to select Drive files, plus public Drive links where accessible. |
| 🔊 Automatic audio compatibility | FFmpeg-based compatible audio for Google Drive videos with unsupported soundtracks; no manual Audio Fix button. |
| 🌐 Multi-language audio | Choose from detected Hindi, English or other embedded audio tracks for supported Google Drive movies; each viewer chooses independently. |
| 📺 Video sources | YouTube, Vimeo, direct video links, uploads and HLS where supported. |
| 🔐 Private rooms | Invite codes, optional passwords, room settings and moderation. |
| 🍿 Movie night extras | Queue, captions for HTML5 videos, BRB, countdown, glow, vibes, notes and recap. |
| 📱 Responsive UI | Watch together on desktop and mobile browsers. |

> Playback depends on browser codecs, Google Drive access, network speed and available server resources. Automatic audio conversion does **not** guarantee support for every possible media format.

## 🚀 Try Watchify online

Open **[watchify.mixify.co.in](https://watchify.mixify.co.in/)**, enter your nickname, and press **Create new room**. Send the invite link or room code to friends. **No Watchify account is required.** Google login is only needed if you choose to connect your personal Drive.

## 💻 Run on localhost

### Requirements

- [Node.js 20+](https://nodejs.org/) and npm
- [FFmpeg](https://ffmpeg.org/) on PATH for automatic Google Drive audio conversion
- **FFprobe** (typically included with FFmpeg) on PATH for detecting embedded audio languages
- Optional: `yt-dlp` on PATH for supported third-party public video links

### Windows / PowerShell

1. Download/clone the repository and open PowerShell in the folder containing `package.json`.
2. Install dependencies once:

   ```powershell
   npm install
   ```

3. Check FFmpeg:

   ```powershell
   ffmpeg -version
   ```

4. Run the app:

   ```powershell
   npm start
   ```

5. Open **http://localhost:3000** on your laptop.

Press **Ctrl+C** to stop the server. Restart it after changing server code.

### 📱 Test localhost on your phone

1. Keep `npm start` running on your laptop.
2. Connect phone and laptop to the **same local network/Wi-Fi**.
3. Run `ipconfig` on Windows and find the laptop's **IPv4 Address** (e.g. `192.168.1.49`).
4. On your phone open `http://YOUR_LAPTOP_IP:3000` (example: `http://192.168.1.49:3000`).
5. If the connection fails, check that Windows Firewall allows Node.js on your trusted **Private** network and that Wi-Fi client isolation is disabled.

Do **not** use `localhost` in the phone browser: that points to the phone itself. Google OAuth on the LAN IP is a separate limitation; use the registered localhost callback on your laptop or the deployed HTTPS site for Drive sign-in.

## ☁️ Optional Google Drive OAuth setup

1. In [Google Cloud Console](https://console.cloud.google.com/), enable **Google Drive API**, configure the OAuth consent screen and create a **Web application** OAuth client.
2. Add this exact local **Authorized redirect URI**: `http://localhost:3000/google-drive/callback`.
3. Copy `.env.example` to `.env` beside `server.js`, then set:

   ```dotenv
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   GOOGLE_REDIRECT_URI=http://localhost:3000/google-drive/callback
   ```

4. Restart `npm start`. Your credentials load from `.env` automatically, so there is **no need to type them again in PowerShell**.

On production, register `https://watchify.mixify.co.in/google-drive/callback` and configure the matching host environment variables. Google `drive.readonly` is a **restricted scope** and may require Google verification for public use. Apps in Testing mode may be limited to test users.

**Never commit `.env`, credentials or access tokens.** Google Drive authorization tokens live in server memory and may require signing in again after restart.

## 🎧 Audio compatibility and buffering

- Google Drive audio conversion is **automatic** and the Audio Fix button is hidden.
- FFmpeg must be installed on the server; set `FFMPEG_PATH` if it is not on PATH.
- For Google Drive movies with **two or more detectable audio tracks**, open **More (⋯) → Audio language** to select a language. The list comes from the movie's track metadata; when language information is missing it shows a generic track label.
- Audio-track discovery uses **FFprobe** (`ffprobe` on PATH or the `FFPROBE_PATH` environment variable). When probing is unavailable or fails, the movie keeps playing its default soundtrack and the language selector remains hidden.
- Each viewer can choose a different soundtrack. Switching tracks restarts that viewer's compatible audio at the current movie timestamp, so a brief loading pause may occur.
- This selector currently applies to **Google Drive compatibility streams**, not to YouTube, Vimeo or all uploaded/direct files.
- Conversion can start separate jobs per viewer. `MAX_AUDIO_JOBS` defaults to `2` (capped at `4`).
- Audio and video are synchronized after starting and seeking, but network buffering or low-CPU hosting can still cause short delays.
- For most reliable playback, use H.264/AAC MP4 when possible. Larger production deployments should consider shared adaptive-bitrate transcoding rather than per-viewer FFmpeg.

## 🎥 Video source support

- **YouTube** and **Vimeo** using their respective embeds
- **Direct links:** MP4, WebM, Ogg, MOV and HLS where the browser supports them
- **Uploaded videos:** stored temporarily for the room
- **Google Drive public links:** only if Google permits direct download; a playable Drive preview is not proof of direct stream access
- **Google Drive account:** optional OAuth connection for authorized files
- **Other public websites:** optional `yt-dlp` where supported; availability varies by source

DRM-protected subscription platforms (such as Netflix, Prime Video or Disney+ Hotstar) **cannot** be streamed through Watchify.

## 🚀 Deploy on Render

1. Connect the GitHub repository to a **Render Web Service**.
2. Use build command `npm install` and start command `npm start`.
3. Set Google OAuth values in **Render → Environment**, never in public files.
4. Ensure FFmpeg is available in your deployment environment for automatic audio conversion.
   Install **FFprobe** as well to enable multi-language track detection.
5. Connect your domain and check `/healthz` (returns `{"ok":true}`).

Room state is in memory; uploads are temporary. **End party** removes that room's uploads, and abandoned rooms are cleaned up after the reconnect grace period. Redeploys/restarts end active rooms. Use **one instance** and configure disk, bandwidth and upload limits (`MAX_MB`, `MAX_ROOM_MB`, `MAX_TOTAL_MB`) for your host. Configure `TRUST_PROXY` only for your actual trusted proxy setup.

## 🔒 Privacy and responsible use

- Guest joining does not require registration.
- Rooms and server uploads are temporary, not permanent cloud storage.
- Deletion cannot remove files already downloaded or cached outside Watchify.
- Stream only content you have permission to use.

---

<div align="center">

**Made with ❤️ by [Priyanshu Sharma](https://portfolio.mixify.co.in/)**

[Watchify](https://watchify.mixify.co.in/) · [Mixify](https://mixify.co.in/) · [Portfolio](https://portfolio.mixify.co.in/)

</div>
