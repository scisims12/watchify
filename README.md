# Watch Party

Rooms, synced playback, chat and upload. Node.js + Express + Socket.io.

## Run
    npm install
    npm start
Open http://localhost:3000

## Supported links
- YouTube (watch, youtu.be, shorts, live, or a bare video ID)
- Vimeo
- Direct files: .mp4 .webm .ogg .mov .m3u8 (HLS)
- Other sites (Dailymotion, X, Facebook...): needs `yt-dlp` installed on the server
- Install `yt-dlp` on the server PATH for optional link resolution (for example, via your host's package manager). Resolution requires room membership and playback permission, allows 6 lookups per socket per minute and at most 2 simultaneous lookups globally. Public links only; DRM is not bypassed.
- Uploaded files: use MP4 with H.264 video for best compatibility
- Google Drive public video links (`drive.google.com/file/d/.../view`): Watchify attempts two Google download endpoints and streams playable bytes through a temporary, room-scoped URL so synchronized HTML5 controls work. In Drive, set **General access â†’ Anyone with the link â†’ Viewer** and permit downloads. No Google login or Drive API key is used. If both endpoints return an error or an HTML page, the `/drive/...` request returns HTTP 422 with safe upstream status/content-type details; **Google's own preview playing does not mean a direct download is available**. Browser codec support is also required: large MKV files and unsupported audio/video codecs may not play even when the bytes are downloadable. Drive traffic passes through your hosting provider and consumes its bandwidth. Room end immediately invalidates the stream URL; no Drive video is saved on the server.
- **Google Drive account (Drive button):** Connect with Google, choose a video from your own Drive and play it via the official authorized Drive API (`files.get?alt=media`). Tokens are kept in server memory; selected video bytes are streamed to members using a room-scoped URL and are never stored by Watchify. The picker is a Watchify-native file list, not the Google-hosted Picker widget. Chrome/HTML5 still cannot decode every MKV codec; Google access or API quota restrictions can still block playback.
- **Audio Fix (experimental, Google Drive only):** The player shows an optional **Audio fix** button for Drive videos with silent/unsupported soundtracks (for example E-AC-3/Dolby Digital Plus). Requires an `ffmpeg` executable installed on the server, discoverable on PATH or set with `FFMPEG_PATH`. The compatibility stream now uses progressive MP3 stereo, avoiding indefinite fragmented-MP4 buffering in HTMLAudioElement. The normal video stream remains unchanged. Every viewer who enables the fix starts an independent conversion, and seeking restarts conversion at that timestamp. `MAX_AUDIO_JOBS` defaults to `2` (maximum `4`). Server PowerShell logs sanitized FFmpeg failures as `[Audio compatibility]` (never post full media URLs or tokens). This is **not guaranteed** to work on every browser or container, and may buffer or fail on low-CPU hosting such as Render Free. For reliable production use, preconvert media to H.264/AAC MP4 or deploy a separate, shared HLS transcoding worker. A temporary room-scoped URL protects the audio stream, and stopping playback or ending the room terminates conversion processes.
- **Audio Sync v3 (experimental):** When the Audio fix is enabled during playback, the video waits locally until compatible audio begins playing. Seeking restarts FFmpeg at the new timestamp and waits again. A per-player clock check attempts media seeking or adjusts compatible audio playback speed to reduce drift. This does not guarantee frame-perfect lip-sync on every device. Test the same movie on two devices, including pause, seek and reconnect, before using it in production.
- **Automatic Drive audio compatibility:** The compatible soundtrack now turns on automatically for Google Drive videos on first use. The **Audio on** button remains available to turn it off when the original audio already plays correctly; this choice is saved in that browser. Automatic transcoding uses FFmpeg CPU for each viewer, even when conversion is unnecessary, so consider disabling it on low-resource hosting or adding codec detection before production rollout.
- **Streaming stability v4 (experimental):** Google Drive's media proxy no longer forcibly drops active streams after 120 seconds; it aborts only after 60 seconds with no incoming bytes. During temporary soundtrack buffering, local video playback waits for the audio again, and the sync clock makes smaller, less frequent speed corrections to reduce micro-stutters. Codec probing/automatic selective conversion and adaptive-bitrate HLS are **not** implemented; every auto-enabled Drive viewer still incurs one FFmpeg job. Validate prolonged playback and seek on real devices before deployment.
- **Hidden audio control:** The Audio Fix button is hidden from the player. Google Drive compatibility starts automatically on every new Drive movie, even if an older browser had saved an OFF preference. This retains the existing separate FFmpeg audio stream and uses CPU per viewer; it does not detect codecs selectively.
- **Invite:** the header's Invite button shows a QR code and Copy link; Web Share is offered on supported browsers. QR rendering uses pinned `qrcodejs@1.0.0` from jsDelivr, so internet access is required to generate it.
- **Subtitles:** for HTML5/uploaded videos, a member with playback permission can use the CC control to upload a plain UTF-8 `.srt` or `.vtt` file (maximum 1 MB). SRT converts to WebVTT on the server. Subtitles are shared with the room, but display on/off and size are chosen separately by each viewer. Replacing the video or ending the party deletes its subtitle file. YouTube/Vimeo use their own captions.

DRM or paid streaming (Netflix, Prime, Hotstar...) cannot be played.

## Room features
- **Host and control modes:** everyone / host only / ask host (remote), lock with password, remove members, ready check with a synchronized countdown.
- **Chat:** typing indicator, unread badge (mobile and background tab), quick reactions that float over the stage, per-user rate limit with a short automatic mute for flooding.
- **Queue:** members suggest videos, the host approves them into the queue, and the next video starts automatically when one ends. The host can also add, play now or remove items.
- **Connection:** a "Reconnecting..." banner, automatic resync after a network drop or when the tab comes back, and quick refreshes no longer spam the chat. If a viewer stalls for more than a moment, everyone pauses ("Waiting for X to buffer") and resumes automatically, with a 15 second cap per viewer.
- **Phase 2 (unique features):**
  - **BRB:** anyone taps BRB, the video pauses for all ("Rahul will be back") and resumes when everyone is back (auto-return after 15 min).
  - **Pass the remote:** Room settings > Members > "Pass remote" lends control for 5 to 30 minutes, then it returns to the host by itself. Everyone sees "Priya has the remote".
  - **Reaction heatmap:** reactions are stored by position in the video and shown as coloured dots on the seek bar.
  - **Timestamp notes:** the Note button pins a note at the current second; it pops up for everyone whenever playback passes that second again.
  - **Movie night:** the host schedules a time in Room settings. The invite link shows a card with a live countdown and an "Add to calendar" file. Friends can join the lobby early and chat; a scheduled room stays alive while empty (kept for 3 hours after start, in memory only).
  - **Ambient glow:** soft light around the player taken from the picture's edges (uploads and CORS-enabled direct files). YouTube/Vimeo cannot be sampled, so they glow in the room vibe colour. Each viewer can toggle Glow.
  - **Recap:** appears when the last video ends, or on demand with the Recap button. Copy text or save as an image.
  - **Room vibes:** Cinema, Cozy, Date night, Party change the colours and glow (host sets it in Room settings).
- **Room hygiene (host):** room name, max members, mute chat, clear chat. Wrong-password attempts are rate limited.

Optional environment variable: `MAX_MEMBERS` (default 50) is the hard cap per room.

Click **Create new room** to create a six-character code. **Join room** and invite links only join existing rooms; an incorrect code shows "Room not found. Check the code, or create a new room." A reconnect never creates a missing room. Existing 5â€“12-character room codes remain accepted.

## Deploy
- **Google Drive OAuth configuration:** Create a Google Cloud project, enable **Google Drive API**, configure the OAuth consent screen and create a **Web application** OAuth client. Add exactly `http://localhost:3000/google-drive/callback` (local development) or `https://watchify.mixify.co.in/google-drive/callback` (production) as an authorized redirect URI, as appropriate. Provide `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` environment variables to Node. Do not put the client secret in `public/index.html` or commit it to GitHub. The implementation requests `drive.readonly` for read-only access to existing files; Google classifies this as a **restricted scope**, so public production use may require OAuth app verification/security assessment. While in Testing mode, Google may allow only explicitly added test users. Google OAuth logins and temporary tokens are held in memory and are lost on restart.
- `PORT` and `MAX_MB` (upload limit, default 2000) are read from the environment.
- `MAX_TOTAL_MB` (default `5000`) caps all uploads on the server; `MAX_ROOM_MB` (default `1000`) caps each room. Both are enforced while streaming, and room deletion releases its storage. Set `MAX_MB` no higher than your host's available disk space.
- `TRUST_PROXY` defaults to `false` (safe for direct access). Set it to `1` or `true` when exactly one trusted reverse proxy (such as Render's edge) forwards requests, or an appropriate hop count / trusted proxy address for your actual Cloudflare/proxy chain. Do not blindly enable it on a publicly reachable Node port: untrusted forwarded IP headers can bypass the invite rate limit.
- `GET /healthz` returns `{ "ok": true }` for health checks. SIGTERM and SIGINT close rooms and delete their uploads before exit.
- Render: create a **Web Service** from this project, build command `npm install`, start command `npm start`, choose one instance. Keep its ephemeral disk; no database or persistent volume is needed for temporary rooms.
- The host can click **End party** to close the room for everyone and delete all videos uploaded for that room. When everyone leaves, an abandoned room is removed after a 30-second host-reconnect grace period (or immediately after the last non-host leaves when the host has already gone).
- Uploads live temporarily in `uploads/`, and old orphaned uploads are purged on server start. Restart/redeploy also loses in-memory rooms, so active watch parties will end. This project is built for **one server instance**, not multi-instance autoscaling.
- For large video uploads, verify your host's request-size, disk-space, bandwidth, and timeout limits. A free tier may be unsuitable for multi-GB files. Consider `MAX_MB=200` on small hosts.
- Deletion is from this app's local storage; it cannot revoke videos already downloaded or browser-cached, or eliminate backups/logs maintained by the hosting provider.
- Only play content you have the rights to.
# Local Google Drive OAuth (one-time setup)

1. Copy `.env.example` to `.env` in the same folder as `server.js`.
2. Replace `YOUR_GOOGLE_CLIENT_ID` and `YOUR_GOOGLE_CLIENT_SECRET` with your own credentials. The localhost callback must be registered in Google Cloud.
3. Run `npm install` once, then `npm start` whenever you want Watchify locally. OAuth environment variables are loaded from `.env` automatically, so no repeated PowerShell input is required.

`.env` is ignored by Git, and **must never** be committed, posted, or included in screenshots. Existing Render environment variables remain in control on production because `.env` does not overwrite already-set values. Google OAuth browser sessions are in memory, so reconnecting Drive after a server restart may still be required.
