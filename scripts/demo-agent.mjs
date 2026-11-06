#!/usr/bin/env node
// Pretends to be an AI agent: writes a HyperFrames composition step by step, like Claude Code or Amp would.
// Usage: node scripts/demo-agent.mjs [demo/index.html] [delay-ms]
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.argv[2] || 'demo/index.html');
const delay = Number(process.argv[3]) || 6000;

const versions = [
  { steps: ['Set up the stage'] },
  { steps: ['Set up the stage', 'Logo mark'], logo: true },
  { steps: ['Set up the stage', 'Logo mark', 'Headline'], logo: true, title: true },
  { steps: ['Set up the stage', 'Logo mark', 'Headline', 'Accent bar and badge'], logo: true, title: true, bar: true, badge: true },
  { steps: ['Set up the stage', 'Logo mark', 'Headline', 'Accent bar and badge', 'Polish copy and color'], logo: true, title: true, bar: true, badge: true, polish: true },
  { steps: ['Set up the stage', 'Logo mark', 'Headline', 'Accent bar and badge', 'Polish copy and color', 'Outro call to action'], logo: true, title: true, bar: true, polish: true, cta: true },
];

function build(v) {
  const comment = v.steps.map(s => `<!-- step: ${s} -->`).join('\n');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #000; }
  #stage { position: relative; width: 1920px; height: 1080px; overflow: hidden; font-family: Inter, system-ui, sans-serif;
    background: radial-gradient(circle at 25% 35%, #26307a 0%, #0b0f24 62%); }
${v.logo ? `  #logo { position: absolute; left: 250px; top: 390px; width: 300px; height: 300px; }
  #logo .ring { position: absolute; inset: 0; border-radius: 50%; border: 18px solid #7c5cff; }
  #logo .core { position: absolute; inset: 85px; border-radius: 30px; background: linear-gradient(135deg, #ff6fb1, #ffb86b); }
` : ''}${v.title ? `  #title { position: absolute; left: 640px; top: 370px; margin: 0; font-size: 160px; font-weight: 800; letter-spacing: -4px; color: ${v.polish ? '#ffd166' : '#ffffff'}; }
  #subtitle { position: absolute; left: 646px; top: 590px; margin: 0; font-size: 50px; color: #a9b8ff; }
` : ''}${v.bar ? `  #bar { position: absolute; left: 646px; top: 690px; width: 560px; height: 12px; border-radius: 6px; background: linear-gradient(90deg, #7c5cff, #ff6fb1); }
` : ''}${v.badge ? `  #badge { position: absolute; left: 1530px; top: 380px; padding: 10px 22px; border-radius: 40px; background: #ff6fb1; color: #1a0b16; font-size: 34px; font-weight: 800; }
` : ''}${v.cta ? `  #cta { position: absolute; left: 646px; top: 780px; padding: 22px 44px; border-radius: 60px; background: #ffffff; color: #0b0f24; font-size: 44px; font-weight: 700; }
` : ''}</style>
</head>
<body>
${comment}
<div id="stage" data-composition-id="launch" data-start="0" data-width="1920" data-height="1080" data-duration="6">
${v.logo ? `  <div id="logo" class="clip" data-start="0" data-duration="6" data-track-index="0"><div class="ring"></div><div class="core"></div></div>
` : ''}${v.title ? `  <h1 id="title" class="clip" data-start="0.4" data-duration="5.6" data-track-index="1">Live Frames</h1>
  <p id="subtitle" class="clip" data-start="${v.polish ? '1.1' : '0.8'}" data-duration="${v.polish ? '4.9' : '5.2'}" data-track-index="2">${v.polish ? 'Motion graphics, built live by AI' : 'Watch the agent build your video'}</p>
` : ''}${v.bar ? `  <div id="bar" class="clip" data-start="1.2" data-duration="4.8" data-track-index="3"></div>
` : ''}${v.badge ? `  <div id="badge" class="clip" data-start="1.5" data-duration="4.5" data-track-index="4">BETA</div>
` : ''}${v.cta ? `  <div id="cta" class="clip" data-start="3.4" data-duration="2.6" data-track-index="4">Try it in Amp →</div>
` : ''}</div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
<script>
  const tl = gsap.timeline({ paused: true });
${v.logo ? `  tl.from("#logo", { scale: 0, rotation: -180, duration: 1, ease: "back.out(1.7)" }, 0.1);
` : ''}${v.title ? `  tl.from("#title", { y: 90, opacity: 0, duration: 0.8, ease: "power3.out" }, 0.5);
  tl.from("#subtitle", { y: 40, opacity: 0, duration: 0.6, ease: "power2.out" }, ${v.polish ? '1.15' : '0.9'});
` : ''}${v.bar ? `  tl.from("#bar", { scaleX: 0, transformOrigin: "left center", duration: 0.8, ease: "power2.inOut" }, 1.3);
` : ''}${v.badge ? `  tl.from("#badge", { scale: 0, duration: 0.45, ease: "back.out(2.5)" }, 1.6);
` : ''}${v.cta ? `  tl.from("#cta", { y: 30, opacity: 0, duration: 0.5, ease: "power2.out" }, 3.5);
` : ''}  window.__timelines = window.__timelines || {};
  window.__timelines.launch = tl;
</script>
</body>
</html>
`;
}

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.rmSync(file, { force: true });
console.log(`Writing ${versions.length} versions to ${file}, one every ${delay} ms`);
for (const [i, v] of versions.entries()) {
  await new Promise(r => setTimeout(r, i === 0 ? 1500 : delay));
  fs.writeFileSync(file, build(v));
  console.log(`v${i + 1}: ${v.steps.at(-1)}`);
}
