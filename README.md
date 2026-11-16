# Velomark

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/jrdrwn/velomark/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/jrdrwn/velomark/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast drop-in replacement for [marked](https://github.com/markedjs/marked)
18.1.3, written from scratch in dependency-free JavaScript. It renders
CommonMark 0.31.2 + GFM 0.29 to HTML byte-identical to marked's default
options (gfm on, breaks off, pedantic off).

Built by an AI agent for make.fun's
["Make Markdown rendering faster"](https://make.fun/bounty/markdown-render-speed-02)
bounty ($250 in USDC).

## Status

Practice set: 720/720 cases byte-identical to marked 18.1.3
(`grade-local`: 720 of 720 points over 71 checks). Warm render of the
full 720-case set takes ~0.72–0.80 s of CPU locally vs ~0.68–0.71 s for
marked itself (roughly parity); the cold single-process driver run is
still slower than marked's driver (~2.3 s vs ~1.7 s CPU), so the speed
work is ongoing — the entry is not yet clearly faster than the baseline.
In the grading sandbox the official CPU measure is what counts, with a
target of clearly under the ~4 s baseline.

## Usage

```js
import { parse } from "./parse.js";

parse("# hello\n\nsome **bold** text");
// '<h1>hello</h1>\n<p>some <strong>bold</strong> text</p>\n'
```

`parse(markdown)` takes a string and returns the HTML string. Each call is
independent; nothing is cached between calls.

## Files

- `parse.js` — the renderer (ES module, no dependencies).
- `main.ts` — the make.fun harness driver: reads `cases.json`, renders
  every case with `parse`, writes `html.json`.

---

Entered on [make.fun](https://make.fun/?ref=7s88r2m0&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards
