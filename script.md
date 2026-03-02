# otslog-web — Screen Recording Narration Script

## Opening — What you're looking at

This is **otslog** — a live dashboard that does two things at the same time: it shows a **live video feed** from a camera, and it **timestamps that video in real-time** using Bitcoin.

Why does this matter? Because these timestamps are **tamper-proof**. Once a piece of video is stamped, no one — not even the camera owner — can alter the footage without breaking the proof. You get mathematical evidence that this exact video existed at this exact moment.

---

## Top Bar

At the top you see the **otslog** logo and two status indicators on the right.

The **first dot** shows whether the browser has a **live connection** to the server — green and pulsing means it's receiving data in real-time.

The **second dot** shows the **system status** — "live" means the camera is streaming and the timestamping process is running.

---

## Left Side — Live Video

The left panel is the **live video player**. The server connects to the camera, encodes the video, and streams it to your browser. When the page loads, the video starts automatically — the "waiting for stream…" overlay disappears once the feed comes through.

Below the video you can see the **stream URL** and the **video resolution**.

---

## Right Side — Sidebar

### Stream Controls (top)

f
At the top of the sidebar are basic **playback controls** — you can change the stream URL or stop and restart the video. For normal use, everything starts automatically.

### Timestamping Output (main section)

This is the heart of the dashboard — the **timestamping panel**. Here you can see the stamping happen live, as it happens.

#### How the timestamping works

Here's what's going on behind the scenes. The server is saving the video into **segment files** — each one about 10 minutes long. As soon as a new segment starts, otslog begins **watching that file** and every **5 seconds**, it:

1. Reads the new video data that's been written
2. Creates a unique **digital fingerprint** of the video up to that point
3. Submits that fingerprint to a **timestamp server**, which batches it and anchors it into a **Bitcoin transaction**

Each stamp that appears on screen tells you three things:

- **When** it was stamped (the clock time)
- **Where** in the file (how far into the video)
- **The fingerprint** — a short code that uniquely identifies all the video data up to that point

This is the proof. If anyone changes even a single frame of the video, the fingerprint won't match — and the Bitcoin record makes it impossible to fake.

#### The segment cards

The stamps are grouped into **cards**, one per video segment.

Each card header shows the **file name**, a **status badge** — blue "STARTED" while it's being stamped, green "DONE" when the segment is complete — and the **total stamp count**.

Inside the card, each row is one stamp:

- **Green checkmark** — successfully submitted
- **Time** — when it was stamped
- **Offset** — how far into the video file
- **Short hash** — the first few characters of the fingerprint

You can click a card to **collapse or expand** it. There's also a "raw output" toggle if you want to see the unprocessed log lines.

#### Active Section — Real-Time Stamping

Now look at the **Active tab** on the right. This is where the action happens live.

See that card — **output_000.mp4** — with the blue **"STARTED"** badge? That's the video segment being recorded right now. Watch the number next to it — it says **"0 stamps"**.

*(pause ~5 seconds, a stamp appears)*

There — **a new row just appeared**. That green checkmark means a timestamp was just created and submitted. Look at what it shows:

- The **clock time** on the left — that's *when* it was stamped
- The **+number** next to it — that's how many bytes of video have been recorded so far
- And that **short code** at the end — that's the fingerprint, a unique ID for all the video up to this point

The counter now says **"1 stamp"**.

*(wait for the next one)*

Another one. Notice the **offset number grew** — that's because the camera kept recording, so there's more video data now. And the **fingerprint changed** — because it covers more video than before. Every stamp is a new proof that covers everything from the start up to that moment.

This keeps going — **every 5 seconds**, a new row drops in. The card scrolls down automatically so you always see the latest one.

As long as this card is in the **Active** tab with a blue "STARTED" badge, the video is being stamped live. When the server rotates to a new file, this card will slide over to **History** with a green **"DONE"** badge — and a new card will appear here for the next segment.

#### History Tab

The two tabs split the segments: **Active** shows the segment currently being stamped (the one the camera is writing to right now), and **History** shows completed segments. When a segment finishes — because the server rotated to a new file — the card moves to History with a "DONE" badge.

You'll typically see **one active segment** at a time, with completed ones stacking up in History.

---

## Closing

So what you're seeing is a fully automated pipeline: **camera → video segments → fingerprinting → Bitcoin**. Every 5 seconds, a new proof is created. Later, you can extract any moment from the video along with its proof file — and anyone can verify it independently against Bitcoin, without needing to trust this server or the camera operator.

That's otslog: **provable, untamperable video timestamps**.
