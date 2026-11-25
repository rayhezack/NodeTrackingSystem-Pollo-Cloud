import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const source = new URL('../skills/pollo-tracking-context/SKILL.md', import.meta.url);
const target = new URL('../client/public/skills/pollo-tracking-context/SKILL.md', import.meta.url);
const text = readFileSync(source, 'utf8');
if (!text.startsWith('---\nname: pollo-tracking-context\ndescription: ')) throw new Error('Invalid context Skill');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== text) throw new Error('Context Skill download is stale');
} else { mkdirSync(new URL('.', target), { recursive: true }); writeFileSync(target, text); }
