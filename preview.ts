import { render } from './src/statusline';
import * as fs from 'fs';

const payload = JSON.parse(fs.readFileSync('./testdata/statusline_payload.json', 'utf8'));

const configs = [
  { name: 'Default (Original Author)', config: { showModel: true, showProgressBar: true, multiline: true, color: true, showGitBranch: true, showCWD: true, showAgentState: true, showIcons: true, contextValue: 'percent', usageValue: 'remaining', debug: false, quotaLayout: 'default', resetFormat: 'time', showPlanTier: true } },
  { name: 'Your Custom Preference', config: { showModel: true, showProgressBar: true, multiline: true, color: true, showGitBranch: true, showCWD: true, showAgentState: true, showIcons: true, contextValue: 'percent', usageValue: 'percent', debug: false, quotaLayout: 'stacked', resetFormat: 'duration', showPlanTier: false } }
];

let html = `
<html><head>
<style>
  body { background: #1e1e1e; color: #d4d4d4; font-family: monospace; padding: 20px; font-size: 16px; }
  pre { padding: 15px; background: #000; border-radius: 5px; line-height: 1.5; font-family: "Fira Code", monospace; }
  h2 { font-family: sans-serif; color: #fff; margin-top: 30px; }
</style>
</head><body>
<h1>agy-hud Final Forms</h1>
`;

const Convert = require('ansi-to-html');
const convert = new Convert({ escapeXML: true });

for (const c of configs) {
  const out = render(payload as any, { config: c.config as any } as any);
  html += `<h2>${c.name}</h2><pre>${convert.toHtml(out).replace(/\n/g, '<br/>')}</pre>`;
}

html += `</body></html>`;
fs.writeFileSync('/tmp/brainstorm-90542-1781896935/content/1.html', html);
