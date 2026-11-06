# BeatBridge: Pioneer DJM-A9 BPM into Onyx, on the beat

BeatBridge syncs moving-head FX and SGM VPL pixel FX in Obsidian Onyx to the BPM from a Pioneer DJM-A9.

## The problem

- **The clock has tempo only.** The DJM-A9 sends a MIDI timing clock over USB: 24 ticks per beat from its BPM counter (AUTO 70–180, or TAP), plus START/STOP from its button. It never says where the downbeat is.
- **Onyx follows that clock in two places only.** Its Beat Provider (Midi Clock, Ableton Link, Tap Sync or audio) drives Chase cuelists and DyLOS.
- **The FX engine runs from a speed value instead.** In practice that value is an Override cue on a playback fader that OSC sets with integers 0–255.

So FX speed is quantised, and nothing keeps an FX on the "1".

## What BeatBridge does

1. **Reads the clock.** Tempo and phase come from a least-squares fit over an adaptive window, so jitter averages out and real tempo changes still settle in under a second.
2. **Holds the bar.** The downbeat comes from MIDI START pressed on the "1", a DJM button (any MIDI note), or a key tap.
3. **Drives Onyx FX-speed faders over OSC.** Each speed is mapped through the curve measured for that fader, and a level is sent only when it changes.
4. **Re-phases FX on the downbeat.** It sends release/go ahead by the measured latency.
5. **Optionally steers** the fader by one step either side, using Onyx's own Art-Net output as feedback, so an FX stays on the bar without restarting every bar.
6. **Calibrates.** It steps each FX-speed fader and times the FX from Onyx's Art-Net output.

## Run

You need Node 20 or newer. MIDI input uses `@julusian/midi` (prebuilt binaries).

```bash
npm install
node cli/beatbridge.js ports
node cli/beatbridge.js log --in DJM --seconds 120 --out clock.csv   # record the real clock
node cli/beatbridge.js analyze clock.csv                            # jitter + tempo report
cp bridge.example.json bridge.json                                  # set OSC host/port, fader ids
node cli/beatbridge.js calibrate --config bridge.json --out curve.json   # paste the curve into bridge.json
node cli/beatbridge.js run --config bridge.json                     # space = downbeat, 1/2/3 = ½×/1×/2×
npm test                                                            # 11 tests
npm run bench                                                       # results/bench.json, results/e2e.json
```

The review site in `site/` (Vercel output directory, `noindex`) does two things:
- It runs the same code in the browser against a simulated DJM-A9.
- It can read a real DJM-A9 through Web MIDI in Chrome or Edge, to measure its jitter and find which button sends which note.

## Onyx side

1. **Beat Provider** (Onyx 4.10+). In the Library, add an Input Source of type Beat Provider, source Midi Clock = DJM-A9, Quantum 4, Beat Control *Track*.
2. **Bar-locked moving-head looks as Chase cuelists.** Set Beat/Sound Trigger to that Beat Provider, with Fade % near 100. These follow the clock natively.
3. **VPL pixels through DyLOS**, synced to the Beat Provider. Patch the VPLs in 8-bit pixel mode: 48 channels per VPL 305.
4. **FX-engine looks.** Each one gets an Override cue with FX speed stored at max, on its own playback fader (`/Mx/fader/<id>`, 0–255), driven by BeatBridge.
5. **Re-phase actions.** Use `/Mx/playback/page<N>/<fader>/release` then `/go` on the FX cue. Check on the console that the restart is seamless for each FX.

## Measured (simulation; `results/`)

| | Result |
|---|---|
| Tempo error at 1 ms USB jitter, steady 128 BPM | Tick-by-tick 11.1 BPM RMS. 1-beat average 0.42. BeatBridge 0.024. |
| Fader updates per minute at a steady tempo | Tick-by-tick 2,781. BeatBridge 0. |
| DJM re-measures 124 → 128 | BeatBridge within 0.15 BPM after 0.74 s; 0.84 s after a 16-beat pitch ride ends |
| 0–255 fader, linear to 240 cycles/min, bar-length FX | Median speed error 0.77 %, so a full beat off after about 1 minute |
| 30-min set: bar FX within 40 ms of the bar | Filtered BPM to the fader only: 2.6 %. Re-phase every 4 bars: 84.7 %. Re-phase every bar: 100 % (943 restarts). Steer + Art-Net feedback + re-phase every 32 bars: 100 %, p95 28 ms (30 restarts). |
| OSC over UDP, 126 BPM | Re-phase interval 1904.58 ms vs bar 1904.76 ms (±0.41 ms) |
| Calibration against an emulated console | Recovered the hidden fader curve within ±1.03 % |

## Scope

Not tested with a real DJM-A9, Onyx, moving heads or VPLs.

The console model makes these assumptions:
- the FX speed follows the last fader level, on a curve 0.5 % off calibration;
- a re-phase restarts the FX when it arrives;
- Art-Net comes back at 40 frames per second.

The jitter levels are assumptions until measured with `log`/`analyze` or the site's Web MIDI tab. The fader curve is an assumption until measured with `calibrate`.

The DJM-A9's clock follows its own BPM counter. How that counter's beat lines up with the music is a separate offset, set with the downbeat and `latencyMs`.
