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

Click **Create new room** to create a six-character code. **Join room** and invite links only join existing rooms; an incorrect code shows "Room not found. Check the code, or create a new room." A reconnect never creates a missing room. Existing 5–12-character room codes remain accepted.

## Deploy
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
