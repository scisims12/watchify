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
- Uploaded files: use MP4 with H.264 video for best compatibility

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

## Deploy
- `PORT` and `MAX_MB` (upload limit, default 2000) are read from the environment.
- Render: create a **Web Service** from this project, build command `npm install`, start command `npm start`, choose one instance. Keep its ephemeral disk; no database or persistent volume is needed for temporary rooms.
- The host can click **End party** to close the room for everyone and delete all videos uploaded for that room. When everyone leaves, an abandoned room is removed after a 30-second host-reconnect grace period (or immediately after the last non-host leaves when the host has already gone).
- Uploads live temporarily in `uploads/`, and old orphaned uploads are purged on server start. Restart/redeploy also loses in-memory rooms, so active watch parties will end. This project is built for **one server instance**, not multi-instance autoscaling.
- For large video uploads, verify your host's request-size, disk-space, bandwidth, and timeout limits. A free tier may be unsuitable for multi-GB files. Consider `MAX_MB=200` on small hosts.
- Deletion is from this app's local storage; it cannot revoke videos already downloaded or browser-cached, or eliminate backups/logs maintained by the hosting provider.
- Only play content you have the rights to.
