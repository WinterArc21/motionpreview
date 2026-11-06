# HyperFrames Live

A live renderer for [HyperFrames](https://github.com/heygen-com/hyperframes) compositions. While an AI agent (Claude Code, Amp, Cursor, …) writes the composition code, you watch an "Agent" cursor build the video on a canvas at the real video size: it moves to each changed element, selects it, clicks, and the change appears. A timeline with clips and keyframes updates at the same time.

The agent still writes normal HyperFrames HTML. The cursor is a visual layer: the viewer compares each saved version with the one before, and turns the differences into cursor actions.

## Run

Node.js 20.11 or later. No dependencies.

```sh
node bin/hyperframes-live.js path/to/index.html   # then open http://localhost:4317 (PORT to change)
```

Demo without an agent (two terminals):

```sh
npm run demo         # viewer, watching demo/index.html
npm run demo:agent   # writes the composition in 6 steps
```

Click **Replay build** to watch the current composition get built again from an empty canvas. Add `?speed=2` to the URL for faster cursor actions.

## Labels from the agent

Tell the agent to mark its work with step comments. Each new step shows in the status bar and as a header in the Activity panel:

```html
<!-- step: Logo reveal -->
```

In scripts and styles, `// step: Logo reveal` and `/* step: Logo reveal */` also work.

## What becomes a cursor action

| Change in the code | Action |
| --- | --- |
| New element (with an `id`, a `data-start`, or a direct child of the composition root) | Adding — the element stays hidden until the cursor clicks it |
| Removed element | Removing |
| New GSAP line that names a selector | Animating |
| Changed CSS rule or attributes | Styling |
| Changed `data-start` / `data-duration` | Retiming — the cursor goes to the clip on the timeline |
| Changed text | Typing |

## Limits of this MVP

- Watches one HTML file. Changes in linked CSS or JS files, and nested sub-compositions, do not show as actions.
- Playback controls GSAP timelines in `window.__timelines` and clip visibility from `data-start`/`data-duration`. Other adapters (Lottie, Three.js, WAAPI) show, but are not seeked.
- No audio, and no export. Use `npx hyperframes render` for the final video.
