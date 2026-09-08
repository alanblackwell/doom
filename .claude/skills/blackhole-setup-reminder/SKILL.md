---
name: blackhole-setup-reminder
description: Use when this looks like a fresh clone/pull on a machine not yet set up for this project, and the user is about to use or asks about the sampler organelle's recording feature. Reminds them that recording system/loopback audio needs one-time, per-machine OS setup.
---

Recording system/loopback audio (as opposed to a real microphone) needs a one-time,
per-machine OS setup that `npm install`/`git pull` can't do for them:
installing BlackHole, creating a Multi-Output Device, and setting it as the
system output. Full steps are in `SETUP.md`'s "(Optional) BlackHole — for
recording system/loopback audio into the sampler" section — point them
there rather than re-deriving the steps. A real microphone/audio interface
needs none of this and works with no extra setup.
